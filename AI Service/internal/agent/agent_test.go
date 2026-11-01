package agent

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"ai-service/internal/deepseek"
	"ai-service/internal/invoice"
)

func sp(s string) *string { return &s }

var paracetamol = invoice.Product{
	ID: "p-1", Code: "T001", Name: "Paracetamol 500mg",
	Units: []invoice.ProductUnit{{ID: "u-1", UnitName: "Viên", ConversionRate: 1}, {ID: "u-2", UnitName: "Hộp", ConversionRate: 100}},
}

func TestFilterMatchesDropsUnknownIDs(t *testing.T) {
	seen := map[string]invoice.Product{"p-1": paracetamol}
	valid := map[int]bool{0: true, 1: true, 2: true}
	got := FilterMatches([]RawMatch{
		{LineIndex: 0, ProductID: sp("p-1"), UnitID: sp("u-2"), Confidence: 0.9, Reason: "ok"},
		{LineIndex: 1, ProductID: sp("p-invented"), UnitID: sp("u-2"), Confidence: 0.99},
		{LineIndex: 2, ProductID: sp("p-1"), UnitID: sp("u-from-other-product"), Confidence: 7},
		{LineIndex: 9, ProductID: sp("p-1")},
	}, seen, valid)

	if m := got[0]; m.Product == nil || m.UnitID != "u-2" || m.Confidence != 0.9 {
		t.Errorf("line 0: %+v", m)
	}
	if m := got[1]; m.Product != nil || m.UnitID != "" || m.Confidence != 0 {
		t.Errorf("invented product must be dropped: %+v", m)
	}
	if m := got[2]; m.Product == nil || m.UnitID != "" || m.Confidence != 1 {
		t.Errorf("foreign unit must be dropped, confidence clamped: %+v", m)
	}
	if _, ok := got[9]; ok {
		t.Error("unknown line index must be ignored")
	}
}

type fakeTools struct{ queries []string }

func (f *fakeTools) SearchProducts(_ context.Context, q string, limit int) ([]invoice.Product, error) {
	f.queries = append(f.queries, q)
	if q == "paracetamol" {
		return []invoice.Product{paracetamol}, nil
	}
	return nil, nil
}
func (f *fakeTools) SearchReference(context.Context, string) (json.RawMessage, error) {
	return json.RawMessage(`[]`), nil
}

func toolCallResp(calls ...map[string]any) map[string]any {
	var tcs []map[string]any
	for _, c := range calls {
		tcs = append(tcs, c)
	}
	return map[string]any{
		"choices": []any{map[string]any{"finish_reason": "tool_calls", "message": map[string]any{"role": "assistant", "content": "", "tool_calls": tcs}}},
		"usage":   map[string]any{"prompt_tokens": 1000, "completion_tokens": 50, "prompt_cache_hit_tokens": 600},
	}
}

func call(id, name, args string) map[string]any {
	return map[string]any{"id": id, "type": "function", "function": map[string]any{"name": name, "arguments": args}}
}

// Fake DeepSeek: round 1 -> search_products, round 2 -> submit_matches (one valid, one invented id).
func TestRunAgainstFakeDeepSeek(t *testing.T) {
	var requests []map[string]any
	var n int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/chat/completions" || r.Header.Get("Authorization") != "Bearer sk-test" {
			http.Error(w, "bad request", 400)
			return
		}
		body, _ := io.ReadAll(r.Body)
		var req map[string]any
		_ = json.Unmarshal(body, &req)
		requests = append(requests, req)
		var resp map[string]any
		switch atomic.AddInt32(&n, 1) {
		case 1:
			resp = toolCallResp(call("call_1", "search_products", `{"query":"paracetamol","limit":5}`))
		default:
			resp = toolCallResp(call("call_2", "submit_matches",
				`{"matches":[{"line_index":0,"product_id":"p-1","unit_id":"u-2","confidence":0.92,"reason":"cung ten"},{"line_index":1,"product_id":"p-made-up","unit_id":null,"confidence":0.8,"reason":"x"}]}`))
		}
		_ = json.NewEncoder(w).Encode(resp)
	}))
	defer srv.Close()

	client := deepseek.New(srv.URL, "sk-test", 5*time.Second, deepseek.Pricing{InputMiss: 0.3, InputHit: 0.006, Output: 1.2})
	tools := &fakeTools{}
	var usage deepseek.Usage
	lines := []invoice.Line{{Index: 0, RawName: "PARACETAMOL 500", RawUnit: "Hộp", Quantity: 2}, {Index: 1, RawName: "ZZZ", RawUnit: "Hộp", Quantity: 1}}
	res, err := Run(context.Background(), client, "deepseek-flash", "ABIPHA", lines, nil, tools, func(u deepseek.Usage) { usage.Add(u) })
	if err != nil {
		t.Fatal(err)
	}
	if res.Rounds != 2 || res.ToolCalls != 1 || len(tools.queries) != 1 {
		t.Errorf("rounds=%d toolcalls=%d queries=%v", res.Rounds, res.ToolCalls, tools.queries)
	}
	if m := res.Matches[0]; m.Product == nil || m.Product.ID != "p-1" || m.UnitID != "u-2" {
		t.Errorf("line 0: %+v", m)
	}
	if m := res.Matches[1]; m.Product != nil {
		t.Errorf("invented id must be dropped: %+v", m)
	}

	// Usage + cost: 2 requests x (400 miss, 600 hit, 50 out).
	wantCost := 2 * (400*0.3 + 600*0.006 + 50*1.2) / 1e6
	if usage.InputTokens != 2000 || usage.CachedInputTokens != 1200 || usage.OutputTokens != 100 || abs(usage.CostUSD-wantCost) > 1e-12 {
		t.Errorf("usage %+v wantCost %v", usage, wantCost)
	}

	// Request shape.
	if len(requests) != 2 {
		t.Fatalf("requests=%d", len(requests))
	}
	r1 := requests[0]
	if r1["model"] != "deepseek-flash" || r1["thinking"].(map[string]any)["type"] != "disabled" {
		t.Errorf("model/thinking: %v", r1)
	}
	if len(r1["tools"].([]any)) != 3 {
		t.Errorf("tools: %v", r1["tools"])
	}
	msgs1 := r1["messages"].([]any)
	if msgs1[0].(map[string]any)["role"] != "system" || len(msgs1) != 2 {
		t.Errorf("round 1 messages: %v", msgs1)
	}
	msgs2 := requests[1]["messages"].([]any)
	if len(msgs2) != 4 {
		t.Fatalf("round 2 messages: %d", len(msgs2))
	}
	asst := msgs2[2].(map[string]any)
	if asst["role"] != "assistant" || len(asst["tool_calls"].([]any)) != 1 {
		t.Errorf("assistant msg: %v", asst)
	}
	toolMsg := msgs2[3].(map[string]any)
	if toolMsg["role"] != "tool" || toolMsg["tool_call_id"] != "call_1" {
		t.Errorf("tool msg: %v", toolMsg)
	}
	var returned []invoice.Product
	if err := json.Unmarshal([]byte(toolMsg["content"].(string)), &returned); err != nil || len(returned) != 1 || returned[0].ID != "p-1" {
		t.Errorf("tool content: %v (%v)", toolMsg["content"], err)
	}
	// System prompt and tool defs must be byte-identical between rounds (prefix cache).
	s1, _ := json.Marshal(msgs1[0])
	s2, _ := json.Marshal(msgs2[0])
	t1, _ := json.Marshal(r1["tools"])
	t2, _ := json.Marshal(requests[1]["tools"])
	if string(s1) != string(s2) || string(t1) != string(t2) {
		t.Error("system prompt / tools changed between rounds")
	}
}

func TestVisionRequestShapeAndRetry(t *testing.T) {
	var attempts int32
	var got map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if atomic.AddInt32(&attempts, 1) == 1 {
			http.Error(w, "overloaded", http.StatusServiceUnavailable)
			return
		}
		body, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(body, &got)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"choices": []any{map[string]any{"message": map[string]any{"role": "assistant", "content": `{"lines":[]}`}}},
			"usage":   map[string]any{"prompt_tokens": 10, "completion_tokens": 2},
		})
	}))
	defer srv.Close()

	c := deepseek.New(srv.URL, "k", 5*time.Second, deepseek.Pricing{})
	c.Backoff = time.Millisecond
	resp, err := c.Chat(context.Background(), deepseek.Request{
		Model: "deepseek-flash",
		Messages: []deepseek.Message{
			{Role: "system", Content: "json please"},
			{Role: "user", Content: []deepseek.ContentPart{{Type: "text", Text: "t"}, {Type: "image_url", ImageURL: &deepseek.ImageURL{URL: "data:image/jpeg;base64,AAAA"}}}},
		},
		ResponseFormat: map[string]string{"type": "json_object"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if attempts != 2 || resp.Text() != `{"lines":[]}` {
		t.Errorf("attempts=%d text=%q", attempts, resp.Text())
	}
	if got["response_format"].(map[string]any)["type"] != "json_object" || got["thinking"].(map[string]any)["type"] != "disabled" {
		t.Errorf("request: %v", got)
	}
	user := got["messages"].([]any)[1].(map[string]any)
	parts := user["content"].([]any)
	img := parts[1].(map[string]any)
	if img["type"] != "image_url" || img["image_url"].(map[string]any)["url"] != "data:image/jpeg;base64,AAAA" {
		t.Errorf("image part: %v", img)
	}
}

func TestChatDoesNotRetryClientErrors(t *testing.T) {
	var attempts int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&attempts, 1)
		http.Error(w, "bad key", http.StatusUnauthorized)
	}))
	defer srv.Close()
	c := deepseek.New(srv.URL, "k", time.Second, deepseek.Pricing{})
	c.Backoff = time.Millisecond
	if _, err := c.Chat(context.Background(), deepseek.Request{Model: "m"}); err == nil || attempts != 1 {
		t.Errorf("err=%v attempts=%d", err, attempts)
	}
}

func abs(v float64) float64 {
	if v < 0 {
		return -v
	}
	return v
}

// Candidates appear in the initial user message and their ids are accepted without any tool call.
func TestRunWithCandidates(t *testing.T) {
	var requests []map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var req map[string]any
		_ = json.Unmarshal(body, &req)
		requests = append(requests, req)
		_ = json.NewEncoder(w).Encode(toolCallResp(call("c1", "submit_matches",
			`{"matches":[{"line_index":0,"product_id":"p-1","unit_id":"u-2","confidence":0.9,"reason":"khop"}]}`)))
	}))
	defer srv.Close()
	client := deepseek.New(srv.URL, "k", 5*time.Second, deepseek.Pricing{})
	tools := &fakeTools{}
	lines := []invoice.Line{{Index: 0, RawName: "PARACETAMOL 500", RawUnit: "Hộp", Quantity: 2}}
	cands := map[int][]invoice.Candidate{0: {{Product: paracetamol, Score: 0.876}}}
	res, err := Run(context.Background(), client, "m", "ABIPHA", lines, cands, tools, nil)
	if err != nil {
		t.Fatal(err)
	}
	if res.ToolCalls != 0 || len(tools.queries) != 0 {
		t.Errorf("no tool call expected: %d %v", res.ToolCalls, tools.queries)
	}
	if m := res.Matches[0]; m.Product == nil || m.Product.ID != "p-1" || m.UnitID != "u-2" {
		t.Errorf("match: %+v", m)
	}
	user := requests[0]["messages"].([]any)[1].(map[string]any)["content"].(string)
	for _, want := range []string{`"id":"p-1"`, `"code":"T001"`, `"name":"Paracetamol 500mg"`, `"id":"u-2"`, `"score":0.88`, `"line_index":0`} {
		if !strings.Contains(user, want) {
			t.Errorf("user message missing %s:\n%s", want, user)
		}
	}
}

func TestSystemPromptStaticWithCandidates(t *testing.T) {
	var sys []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var req map[string]any
		_ = json.Unmarshal(body, &req)
		b, _ := json.Marshal(req["messages"].([]any)[0])
		sys = append(sys, string(b))
		_ = json.NewEncoder(w).Encode(toolCallResp(call("c", "submit_matches", `{"matches":[]}`)))
	}))
	defer srv.Close()
	client := deepseek.New(srv.URL, "k", 5*time.Second, deepseek.Pricing{})
	lines := []invoice.Line{{Index: 0, RawName: "X"}}
	_, _ = Run(context.Background(), client, "m", "", lines, nil, &fakeTools{}, nil)
	_, _ = Run(context.Background(), client, "m", "", lines, map[int][]invoice.Candidate{0: {{Product: paracetamol, Score: 1}}}, &fakeTools{}, nil)
	if len(sys) != 2 || sys[0] != sys[1] {
		t.Error("system prompt must not depend on candidates")
	}
}
