// Package deepseek is a minimal OpenAI-compatible chat client for the DeepSeek API.
package deepseek

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"
)

type Pricing struct {
	InputMiss float64 // USD per 1M tokens
	InputHit  float64
	Output    float64
}

type Usage struct {
	InputTokens       int     `json:"input_tokens"`
	CachedInputTokens int     `json:"cached_input_tokens"`
	OutputTokens      int     `json:"output_tokens"`
	CostUSD           float64 `json:"cost_usd"`
}

func (u *Usage) Add(o Usage) {
	u.InputTokens += o.InputTokens
	u.CachedInputTokens += o.CachedInputTokens
	u.OutputTokens += o.OutputTokens
	u.CostUSD += o.CostUSD
}

// Cost computes the USD cost; prompt_tokens includes the cache-hit tokens.
func (p Pricing) Cost(input, cached, output int) float64 {
	miss := input - cached
	if miss < 0 {
		miss = 0
	}
	return (float64(miss)*p.InputMiss + float64(cached)*p.InputHit + float64(output)*p.Output) / 1e6
}

type ContentPart struct {
	Type     string    `json:"type"`
	Text     string    `json:"text,omitempty"`
	ImageURL *ImageURL `json:"image_url,omitempty"`
}

type ImageURL struct {
	URL string `json:"url"`
}

type ToolCall struct {
	ID       string       `json:"id"`
	Type     string       `json:"type"`
	Function ToolFunction `json:"function"`
}

type ToolFunction struct {
	Name      string `json:"name"`
	Arguments string `json:"arguments"`
}

// Message.Content is a string or []ContentPart (images are only allowed in user messages).
type Message struct {
	Role       string     `json:"role"`
	Content    any        `json:"content,omitempty"`
	ToolCalls  []ToolCall `json:"tool_calls,omitempty"`
	ToolCallID string     `json:"tool_call_id,omitempty"`
}

type Tool struct {
	Type     string      `json:"type"`
	Function FunctionDef `json:"function"`
}

type FunctionDef struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	Parameters  map[string]any `json:"parameters"`
}

type Request struct {
	Model          string            `json:"model"`
	Messages       []Message         `json:"messages"`
	Tools          []Tool            `json:"tools,omitempty"`
	ToolChoice     any               `json:"tool_choice,omitempty"`
	ResponseFormat map[string]string `json:"response_format,omitempty"`
	Thinking       map[string]string `json:"thinking"`
	Temperature    *float64          `json:"temperature,omitempty"`
	MaxTokens      int               `json:"max_tokens,omitempty"`
}

type Response struct {
	Message      Message
	FinishReason string
	Usage        Usage
}

type apiResponse struct {
	Choices []struct {
		Message struct {
			Role      string     `json:"role"`
			Content   string     `json:"content"`
			ToolCalls []ToolCall `json:"tool_calls"`
		} `json:"message"`
		FinishReason string `json:"finish_reason"`
	} `json:"choices"`
	Usage struct {
		PromptTokens         int `json:"prompt_tokens"`
		CompletionTokens     int `json:"completion_tokens"`
		PromptCacheHitTokens int `json:"prompt_cache_hit_tokens"`
	} `json:"usage"`
}

type Client struct {
	BaseURL string
	APIKey  string
	HTTP    *http.Client
	Pricing Pricing
	Backoff time.Duration // wait before the single retry (default 1s)
}

func New(baseURL, apiKey string, timeout time.Duration, pricing Pricing) *Client {
	return &Client{BaseURL: baseURL, APIKey: apiKey, HTTP: &http.Client{Timeout: timeout}, Pricing: pricing, Backoff: time.Second}
}

// APIError is returned for non-2xx responses after the retry.
type APIError struct {
	Status int
	Body   string
}

func (e *APIError) Error() string { return fmt.Sprintf("deepseek status %d: %s", e.Status, e.Body) }

func (c *Client) Chat(ctx context.Context, req Request) (*Response, error) {
	if req.Thinking == nil {
		req.Thinking = map[string]string{"type": "disabled"}
	}
	body, err := json.Marshal(req)
	if err != nil {
		return nil, err
	}
	var lastErr error
	for attempt := 0; attempt < 2; attempt++ {
		if attempt > 0 {
			backoff := c.Backoff
			if backoff <= 0 {
				backoff = time.Second
			}
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(backoff):
			}
		}
		resp, retry, err := c.do(ctx, body)
		if err == nil {
			return resp, nil
		}
		lastErr = err
		if !retry || ctx.Err() != nil {
			break
		}
	}
	return nil, lastErr
}

func (c *Client) do(ctx context.Context, body []byte) (*Response, bool, error) {
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, c.BaseURL+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		return nil, false, err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Authorization", "Bearer "+c.APIKey)
	res, err := c.HTTP.Do(httpReq)
	if err != nil {
		return nil, true, err
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(res.Body, 16<<20))
	if err != nil {
		return nil, true, err
	}
	if res.StatusCode < 200 || res.StatusCode > 299 {
		retry := res.StatusCode == http.StatusTooManyRequests || res.StatusCode >= 500
		snippet := string(raw)
		if len(snippet) > 500 {
			snippet = snippet[:500]
		}
		return nil, retry, &APIError{Status: res.StatusCode, Body: snippet}
	}
	var api apiResponse
	if err := json.Unmarshal(raw, &api); err != nil {
		return nil, false, fmt.Errorf("decode deepseek response: %w", err)
	}
	if len(api.Choices) == 0 {
		return nil, false, errors.New("deepseek returned no choices")
	}
	ch := api.Choices[0]
	u := Usage{InputTokens: api.Usage.PromptTokens, CachedInputTokens: api.Usage.PromptCacheHitTokens, OutputTokens: api.Usage.CompletionTokens}
	u.CostUSD = c.Pricing.Cost(u.InputTokens, u.CachedInputTokens, u.OutputTokens)
	out := &Response{
		Message:      Message{Role: "assistant", ToolCalls: ch.Message.ToolCalls},
		FinishReason: ch.FinishReason,
		Usage:        u,
	}
	if ch.Message.Content != "" {
		out.Message.Content = ch.Message.Content
	}
	return out, false, nil
}

// Text returns the assistant text content ("" if none).
func (r *Response) Text() string {
	s, _ := r.Message.Content.(string)
	return s
}
