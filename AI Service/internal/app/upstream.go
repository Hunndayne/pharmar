package app

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"net/url"
	"strconv"
	"strings"
	"time"

	"ai-service/internal/config"
	"ai-service/internal/invoice"
)

// Upstream calls the other Pharmar services, always forwarding the caller's Authorization header.
type Upstream struct {
	cfg  config.Config
	http *http.Client
}

func NewUpstream(cfg config.Config) *Upstream {
	return &Upstream{cfg: cfg, http: &http.Client{Timeout: 30 * time.Second}}
}

type UploadedFile struct {
	ID   string `json:"id"`
	Size int64  `json:"size"`
}

func (u *Upstream) get(ctx context.Context, auth, rawURL string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return err
	}
	if auth != "" {
		req.Header.Set("Authorization", auth)
	}
	res, err := u.http.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(res.Body, 8<<20))
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return fmt.Errorf("GET %s: status %d", rawURL, res.StatusCode)
	}
	return json.Unmarshal(body, out)
}

// UploadFile stores data in File Service with an explicit part Content-Type.
func (u *Upstream) UploadFile(ctx context.Context, auth, filename, contentType string, data []byte, refID string) (UploadedFile, error) {
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	h := make(textproto.MIMEHeader)
	h.Set("Content-Disposition", fmt.Sprintf(`form-data; name="file"; filename=%q`, filename))
	h.Set("Content-Type", contentType)
	part, err := mw.CreatePart(h)
	if err != nil {
		return UploadedFile{}, err
	}
	_, _ = part.Write(data)
	_ = mw.WriteField("category", "invoice")
	_ = mw.WriteField("ref_type", "purchase_invoice")
	_ = mw.WriteField("ref_id", refID)
	_ = mw.Close()

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, u.cfg.FileServiceURL+"/api/v1/file/upload", &buf)
	if err != nil {
		return UploadedFile{}, err
	}
	req.Header.Set("Content-Type", mw.FormDataContentType())
	if auth != "" {
		req.Header.Set("Authorization", auth)
	}
	client := &http.Client{Timeout: 60 * time.Second}
	res, err := client.Do(req)
	if err != nil {
		return UploadedFile{}, err
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return UploadedFile{}, fmt.Errorf("file-service upload %s: status %d", filename, res.StatusCode)
	}
	var out UploadedFile
	if err := json.Unmarshal(body, &out); err != nil || out.ID == "" {
		return UploadedFile{}, fmt.Errorf("file-service upload %s: bad response", filename)
	}
	return out, nil
}

func (u *Upstream) Suppliers(ctx context.Context, auth string) ([]invoice.Supplier, error) {
	var out []invoice.Supplier
	err := u.get(ctx, auth, u.cfg.InventoryServiceURL+"/api/v1/inventory/meta/suppliers", &out)
	return out, err
}

type DuplicateReceipt struct {
	ID          string `json:"id"`
	Code        string `json:"code"`
	ReceiptDate string `json:"receipt_date"`
	SupplierID  string `json:"supplier_id,omitempty"`
	Status      string `json:"status,omitempty"`
}

func (u *Upstream) ReceiptsByInvoice(ctx context.Context, auth, serial, number string) ([]DuplicateReceipt, error) {
	q := url.Values{"serial": {serial}, "number": {number}}
	var out []DuplicateReceipt
	err := u.get(ctx, auth, u.cfg.InventoryServiceURL+"/api/v1/inventory/import-receipts/by-invoice?"+q.Encode(), &out)
	return out, err
}

// PriceIncludesVAT reads the public Store setting; any error means "true".
func (u *Upstream) PriceIncludesVAT(ctx context.Context, auth string) bool {
	var s struct {
		Value any `json:"value"`
	}
	if err := u.get(ctx, auth, u.cfg.StoreServiceURL+"/api/v1/store/settings/purchase.ai_price_includes_vat", &s); err != nil {
		return true
	}
	switch v := s.Value.(type) {
	case bool:
		return v
	case string:
		b, err := strconv.ParseBool(strings.TrimSpace(v))
		if err != nil {
			return true
		}
		return b
	}
	return true
}

func (u *Upstream) SearchProducts(ctx context.Context, auth, query string, limit int) ([]invoice.Product, error) {
	q := url.Values{"q": {query}, "limit": {strconv.Itoa(limit)}}
	var out []invoice.Product
	err := u.get(ctx, auth, u.cfg.CatalogServiceURL+"/api/v1/catalog/products/search?"+q.Encode(), &out)
	return out, err
}

func (u *Upstream) ProductByID(ctx context.Context, auth, id string) (invoice.Product, error) {
	var out invoice.Product
	err := u.get(ctx, auth, u.cfg.CatalogServiceURL+"/api/v1/catalog/products/"+url.PathEscape(id), &out)
	return out, err
}

// SearchReference returns a trimmed JSON list of Ministry of Health register entries.
func (u *Upstream) SearchReference(ctx context.Context, auth, query string) (json.RawMessage, error) {
	q := url.Values{"q": {query}, "limit": {"10"}}
	var rows []map[string]any
	if err := u.get(ctx, auth, u.cfg.CatalogServiceURL+"/api/v1/catalog/reference/drugs/search?"+q.Encode(), &rows); err != nil {
		return nil, err
	}
	keep := []string{"registration_number", "name", "active_ingredient", "strength", "dosage_form", "packaging", "manufacturer"}
	trimmed := make([]map[string]any, 0, len(rows))
	for _, r := range rows {
		t := map[string]any{}
		for _, k := range keep {
			if v, ok := r[k]; ok && v != nil {
				t[k] = v
			}
		}
		trimmed = append(trimmed, t)
	}
	return json.Marshal(trimmed)
}

// agentTools adapts Upstream + the caller's auth header to agent.Tools.
type agentTools struct {
	up   *Upstream
	auth string
}

func (a agentTools) SearchProducts(ctx context.Context, q string, limit int) ([]invoice.Product, error) {
	return a.up.SearchProducts(ctx, a.auth, q, limit)
}

func (a agentTools) SearchReference(ctx context.Context, q string) (json.RawMessage, error) {
	return a.up.SearchReference(ctx, a.auth, q)
}
