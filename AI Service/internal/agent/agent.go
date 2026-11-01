// Package agent runs the tool-calling loop that matches invoice lines to catalog products.
package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"strings"

	"ai-service/internal/deepseek"
	"ai-service/internal/invoice"
	"ai-service/internal/prompts"
)

const (
	MaxRounds    = 6
	MaxToolCalls = 30
)

type Chatter interface {
	Chat(ctx context.Context, req deepseek.Request) (*deepseek.Response, error)
}

// Tools is the backend of the search tools (catalog-service in production, a fake in tests).
type Tools interface {
	SearchProducts(ctx context.Context, query string, limit int) ([]invoice.Product, error)
	SearchReference(ctx context.Context, query string) (json.RawMessage, error)
}

// Match is a validated match: ProductID/UnitID are guaranteed to have been returned by search_products.
type Match struct {
	LineIndex  int
	Product    *invoice.Product // nil when unmatched
	UnitID     string           // "" when unknown / not belonging to Product
	Confidence float64
	Reason     string
}

type RawMatch struct {
	LineIndex  int     `json:"line_index"`
	ProductID  *string `json:"product_id"`
	UnitID     *string `json:"unit_id"`
	Confidence float64 `json:"confidence"`
	Reason     string  `json:"reason"`
}

type lineInput struct {
	LineIndex int     `json:"line_index"`
	RawName   string  `json:"raw_name"`
	RawUnit   string  `json:"raw_unit"`
	Quantity  float64 `json:"quantity"`
}

// FilterMatches drops every product_id that was not returned by a search_products call in this run
// (and every unit_id that does not belong to the matched product), and ignores unknown line indexes.
func FilterMatches(raw []RawMatch, seen map[string]invoice.Product, validLines map[int]bool) map[int]Match {
	out := map[int]Match{}
	for _, m := range raw {
		if !validLines[m.LineIndex] {
			continue
		}
		res := Match{LineIndex: m.LineIndex, Reason: strings.TrimSpace(m.Reason)}
		if m.ProductID != nil {
			if p, ok := seen[*m.ProductID]; ok {
				pc := p
				res.Product = &pc
				res.Confidence = clamp01(m.Confidence)
				if m.UnitID != nil {
					for _, u := range p.Units {
						if u.ID == *m.UnitID {
							res.UnitID = u.ID
							break
						}
					}
				}
			}
		}
		out[m.LineIndex] = res
	}
	return out
}

func clamp01(v float64) float64 {
	if v < 0 {
		return 0
	}
	if v > 1 {
		return 1
	}
	return v
}

type Result struct {
	Matches   map[int]Match
	Rounds    int
	ToolCalls int
}

// Run executes the agent loop for the given (unmatched) lines. candidates (optional) are pre-retrieved catalog products per line index; they are shown to the model and count as "seen" ids. onUsage is called after every model request.
func Run(ctx context.Context, chat Chatter, model, supplierName string, lines []invoice.Line, candidates map[int][]invoice.Candidate, tools Tools, onUsage func(deepseek.Usage)) (Result, error) {
	res := Result{Matches: map[int]Match{}}
	if len(lines) == 0 {
		return res, nil
	}
	inputs := make([]lineInput, 0, len(lines))
	valid := map[int]bool{}
	for _, l := range lines {
		inputs = append(inputs, lineInput{LineIndex: l.Index, RawName: l.RawName, RawUnit: l.RawUnit, Quantity: l.Quantity})
		valid[l.Index] = true
	}
	payload, _ := json.Marshal(inputs)
	userText := fmt.Sprintf("Supplier: %s\nInvoice lines to match (json):\n%s", supplierName, payload)

	seen := map[string]invoice.Product{}
	if section := candidatesSection(lines, candidates, seen); section != "" {
		userText += "\nCandidate catalog products per line, found by accent-insensitive name similarity (json, score 0..1):\n" + section
	}

	msgs := []deepseek.Message{
		{Role: "system", Content: prompts.AgentSystem},
		{Role: "user", Content: userText},
	}
	toolDefs := prompts.AgentTools()
	zero := 0.0

	for round := 1; round <= MaxRounds; round++ {
		res.Rounds = round
		req := deepseek.Request{
			Model: model, Messages: msgs, Tools: toolDefs, Temperature: &zero,
			Thinking: map[string]string{"type": "disabled"},
		}
		if round == MaxRounds || res.ToolCalls >= MaxToolCalls {
			req.ToolChoice = map[string]any{"type": "function", "function": map[string]string{"name": "submit_matches"}}
		}
		resp, err := chat.Chat(ctx, req)
		if err != nil {
			return res, err
		}
		if onUsage != nil {
			onUsage(resp.Usage)
		}
		msgs = append(msgs, resp.Message)

		if len(resp.Message.ToolCalls) == 0 {
			msgs = append(msgs, deepseek.Message{Role: "user", Content: "Call submit_matches now with the final result (use null where unsure)."})
			continue
		}
		for _, tc := range resp.Message.ToolCalls {
			if tc.Function.Name == "submit_matches" {
				var args struct {
					Matches []RawMatch `json:"matches"`
				}
				if err := json.Unmarshal([]byte(tc.Function.Arguments), &args); err != nil {
					return res, fmt.Errorf("submit_matches arguments: %w", err)
				}
				res.Matches = FilterMatches(args.Matches, seen, valid)
				return res, nil
			}
			res.ToolCalls++
			msgs = append(msgs, deepseek.Message{Role: "tool", ToolCallID: tc.ID, Content: execTool(ctx, tools, tc, res.ToolCalls, seen)})
		}
	}
	return res, nil
}

func execTool(ctx context.Context, tools Tools, tc deepseek.ToolCall, n int, seen map[string]invoice.Product) string {
	if n > MaxToolCalls {
		return `{"error":"tool call budget exhausted, call submit_matches now"}`
	}
	var args struct {
		Query string `json:"query"`
		Limit int    `json:"limit"`
	}
	if err := json.Unmarshal([]byte(tc.Function.Arguments), &args); err != nil || strings.TrimSpace(args.Query) == "" {
		return `{"error":"invalid arguments: query is required"}`
	}
	switch tc.Function.Name {
	case "search_products":
		limit := args.Limit
		if limit <= 0 {
			limit = 10
		}
		if limit > 20 {
			limit = 20
		}
		products, err := tools.SearchProducts(ctx, strings.TrimSpace(args.Query), limit)
		if err != nil {
			return `{"error":"search failed"}`
		}
		for _, p := range products {
			seen[p.ID] = p
		}
		b, _ := json.Marshal(products)
		if products == nil {
			return "[]"
		}
		return string(b)
	case "search_reference_drugs":
		raw, err := tools.SearchReference(ctx, strings.TrimSpace(args.Query))
		if err != nil {
			return `{"error":"search failed"}`
		}
		return string(raw)
	default:
		return `{"error":"unknown tool"}`
	}
}

type candUnit struct {
	ID             string  `json:"id"`
	UnitName       string  `json:"unit_name"`
	ConversionRate float64 `json:"conversion_rate"`
}

type candProduct struct {
	ID    string     `json:"id"`
	Code  string     `json:"code"`
	Name  string     `json:"name"`
	Units []candUnit `json:"units"`
	Score float64    `json:"score"`
}

type lineCandidates struct {
	LineIndex  int           `json:"line_index"`
	Candidates []candProduct `json:"candidates"`
}

// candidatesSection renders the candidates compactly (line order) and registers their ids as seen.
func candidatesSection(lines []invoice.Line, cands map[int][]invoice.Candidate, seen map[string]invoice.Product) string {
	var out []lineCandidates
	for _, l := range lines {
		cs := cands[l.Index]
		if len(cs) == 0 {
			continue
		}
		lc := lineCandidates{LineIndex: l.Index}
		for _, c := range cs {
			seen[c.Product.ID] = c.Product
			cp := candProduct{ID: c.Product.ID, Code: c.Product.Code, Name: c.Product.Name, Score: math.Round(c.Score*100) / 100}
			for _, u := range c.Product.Units {
				cp.Units = append(cp.Units, candUnit{ID: u.ID, UnitName: u.UnitName, ConversionRate: u.ConversionRate})
			}
			lc.Candidates = append(lc.Candidates, cp)
		}
		out = append(out, lc)
	}
	if len(out) == 0 {
		return ""
	}
	b, _ := json.Marshal(out)
	return string(b)
}
