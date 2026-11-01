// Package app orchestrates the invoice extraction flow.
package app

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"ai-service/internal/agent"
	"ai-service/internal/config"
	"ai-service/internal/deepseek"
	"ai-service/internal/imgstore"
	"ai-service/internal/invoice"
	"ai-service/internal/prompts"
	"ai-service/internal/textutil"
)

func logf(format string, args ...any) { log.Printf(format, args...) }

// Error carries an HTTP status and a Vietnamese detail message.
type Error struct {
	Status int
	Detail string
}

func (e *Error) Error() string { return e.Detail }

func newErr(status int, detail string) *Error { return &Error{Status: status, Detail: detail} }

type Service struct {
	cfg  config.Config
	pool *pgxpool.Pool
	up   *Upstream
	ds   *deepseek.Client
}

func New(ctx context.Context, cfg config.Config) (*Service, error) {
	pool, err := pgxpool.New(ctx, cfg.DatabaseURL)
	if err != nil {
		return nil, fmt.Errorf("connect database: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping database: %w", err)
	}
	if err := ensureSchema(ctx, pool); err != nil {
		pool.Close()
		return nil, err
	}
	s := &Service{cfg: cfg, pool: pool, up: NewUpstream(cfg)}
	if cfg.AIEnabled() {
		s.ds = deepseek.New(cfg.DeepSeekBaseURL, cfg.DeepSeekAPIKey, time.Duration(cfg.RequestTimeoutSeconds)*time.Second,
			deepseek.Pricing{InputMiss: cfg.PriceInputMiss, InputHit: cfg.PriceInputHit, Output: cfg.PriceOutput})
	}
	return s, nil
}

func (s *Service) Close() { s.pool.Close() }

// ---- request / response types ----

type Original struct {
	Filename string
	Data     []byte
}

type ExtractInput struct {
	Auth      string
	UserID    string
	Pages     [][]byte
	Originals []Original
	Sources   []imgstore.Source
	PDFText   string
}

type FileResult struct {
	FileID      string `json:"file_id"`
	Kind        string `json:"kind"`
	ContentType string `json:"content_type"`
	Page        *int   `json:"page"`
	PageCount   *int   `json:"page_count,omitempty"`
	Size        int64  `json:"size"`
}

type MatchResult struct {
	ProductID   string  `json:"product_id"`
	ProductCode string  `json:"product_code"`
	ProductName string  `json:"product_name"`
	UnitID      *string `json:"unit_id"`
	UnitName    *string `json:"unit_name"`
	Conversion  float64 `json:"conversion"`
	Confidence  float64 `json:"confidence"`
	Source      string  `json:"source"`
	Reason      string  `json:"reason"`
}

type LineResult struct {
	Index     int           `json:"index"`
	RawName   string        `json:"raw_name"`
	RawUnit   string        `json:"raw_unit"`
	Quantity  float64       `json:"quantity"`
	UnitPrice *float64      `json:"unit_price"`
	Amount    *float64      `json:"amount"`
	VATRate   *float64      `json:"vat_rate"`
	IsFree    bool          `json:"is_free"`
	Match     *MatchResult  `json:"match"`
	Draft     invoice.Draft `json:"draft"`
	Notes     []string      `json:"notes"`
}

type ExtractResult struct {
	ExtractionID      string                `json:"extraction_id"`
	Files             []FileResult          `json:"files"`
	Invoice           invoice.Header        `json:"invoice"`
	Supplier          invoice.SupplierMatch `json:"supplier"`
	DuplicateReceipts []DuplicateReceipt    `json:"duplicate_receipts"`
	PriceIncludesVAT  bool                  `json:"price_includes_vat"`
	Lines             []LineResult          `json:"lines"`
	Warnings          []string              `json:"warnings"`
	Usage             deepseek.Usage        `json:"usage"`
}

// ---- main flow ----

func (s *Service) Extract(ctx context.Context, in ExtractInput) (*ExtractResult, error) {
	if !s.cfg.AIEnabled() {
		return nil, newErr(http.StatusServiceUnavailable, "Chưa cấu hình AI")
	}
	sizes := make([]int, len(in.Originals))
	for i, o := range in.Originals {
		sizes[i] = len(o.Data)
	}
	plan, err := imgstore.PlanStorage(in.Sources, len(in.Pages), sizes, s.cfg.KeepPDFMaxBytes)
	if err != nil {
		return nil, newErr(http.StatusBadRequest, "Trường sources không hợp lệ: "+err.Error())
	}
	if err := s.checkBudget(ctx); err != nil {
		return nil, err
	}

	extractionID := uuid.NewString()
	res := &ExtractResult{ExtractionID: extractionID, Files: []FileResult{}, DuplicateReceipts: []DuplicateReceipt{}, Warnings: []string{}}

	// Archive the originals concurrently with the AI work; a failure only costs the archive.
	var files []FileResult
	var storeWarnings []string
	var storeWG sync.WaitGroup
	storeWG.Add(1)
	go func() {
		defer storeWG.Done()
		files, storeWarnings = s.storeFiles(context.WithoutCancel(ctx), in, plan, extractionID)
	}()

	var usage deepseek.Usage
	var usageMu sync.Mutex
	record := func(kind, model string) func(deepseek.Usage) {
		return func(u deepseek.Usage) {
			usageMu.Lock()
			usage.Add(u)
			usageMu.Unlock()
			s.logUsage(context.WithoutCancel(ctx), kind, model, in.UserID, u.InputTokens, u.CachedInputTokens, u.OutputTokens, u.CostUSD)
		}
	}

	raw, err := s.readInvoice(ctx, in, record("extract_vision", s.cfg.DeepSeekVisionModel))
	if err != nil {
		storeWG.Wait()
		return nil, err
	}
	header := invoice.BuildHeader(raw)
	lines := invoice.BuildLines(raw.Lines, header.VATRate)
	res.Invoice = header
	res.Warnings = append(res.Warnings, invoice.Check(header, lines)...)

	// Supplier
	res.Supplier = invoice.SupplierMatch{Candidates: []invoice.SupplierCandidate{}}
	if suppliers, err := s.up.Suppliers(ctx, in.Auth); err != nil {
		logf("suppliers lookup failed: %v", err)
		res.Warnings = append(res.Warnings, "Không tải được danh sách nhà cung cấp, hãy chọn nhà cung cấp thủ công")
	} else {
		res.Supplier = invoice.MatchSupplier(header.SupplierName, header.SupplierTaxCode, suppliers)
	}

	// Duplicate invoice
	if header.Serial != "" && header.Number != "" {
		if dups, err := s.up.ReceiptsByInvoice(ctx, in.Auth, header.Serial, header.Number); err != nil {
			logf("duplicate lookup failed: %v", err)
		} else if dups != nil {
			res.DuplicateReceipts = dups
		}
	}

	res.PriceIncludesVAT = s.up.PriceIncludesVAT(ctx, in.Auth)

	// Matching
	matches, matchWarnings := s.matchLines(ctx, in, res.Supplier, header, lines, record("agent", s.cfg.DeepSeekAgentModel))
	res.Warnings = append(res.Warnings, matchWarnings...)

	// Units & prices
	res.Lines = make([]LineResult, 0, len(lines))
	for _, l := range lines {
		lr := LineResult{
			Index: l.Index, RawName: l.RawName, RawUnit: l.RawUnit, Quantity: l.Quantity,
			UnitPrice: l.UnitPrice, Amount: l.Amount, VATRate: l.VATRate, IsFree: l.IsFree, Notes: []string{},
		}
		m, ok := matches[l.Index]
		if !ok {
			lr.Draft = invoice.Convert(l, invoice.ProductUnit{}, nil, res.PriceIncludesVAT).Draft
			res.Lines = append(res.Lines, lr)
			continue
		}
		unit, unitOK := invoice.ResolveUnit(m.UnitID, l.RawUnit, m.Product.Units)
		mr := &MatchResult{
			ProductID: m.Product.ID, ProductCode: m.Product.Code, ProductName: m.Product.Name,
			Confidence: m.Confidence, Source: m.Source, Reason: m.Reason, Conversion: 1,
		}
		if unitOK {
			uid, uname := unit.ID, unit.UnitName
			mr.UnitID, mr.UnitName, mr.Conversion = &uid, &uname, unit.ConversionRate
		} else {
			lr.Notes = append(lr.Notes, "Chưa xác định được đơn vị tương ứng trong danh mục, hãy chọn đơn vị thủ công")
		}
		conv := invoice.Convert(l, unit, m.Product.Units, res.PriceIncludesVAT)
		lr.Match, lr.Draft = mr, conv.Draft
		lr.Notes = append(lr.Notes, conv.Notes...)
		if conv.Warning != "" {
			res.Warnings = append(res.Warnings, conv.Warning)
		}
		res.Lines = append(res.Lines, lr)
	}

	storeWG.Wait()
	res.Files = files
	if files == nil {
		res.Files = []FileResult{}
	}
	res.Warnings = append(res.Warnings, storeWarnings...)
	usageMu.Lock()
	res.Usage = usage
	usageMu.Unlock()
	return res, nil
}

func (s *Service) checkBudget(ctx context.Context) error {
	if s.cfg.DailyBudgetUSD <= 0 {
		return nil
	}
	u, err := s.UsageToday(ctx)
	if err != nil {
		return newErr(http.StatusInternalServerError, "Không kiểm tra được hạn mức AI trong ngày")
	}
	if u.CostUSD >= s.cfg.DailyBudgetUSD {
		return newErr(http.StatusTooManyRequests, fmt.Sprintf("Đã vượt hạn mức AI trong ngày ($%.2f / $%.2f). Vui lòng thử lại vào ngày mai hoặc nhập tay.", u.CostUSD, s.cfg.DailyBudgetUSD))
	}
	return nil
}

// ---- storage ----

func (s *Service) storeFiles(ctx context.Context, in ExtractInput, plan imgstore.Plan, extractionID string) ([]FileResult, []string) {
	type job struct {
		slot  int
		pdf   bool
		orig  int
		page  int
		pages int
	}
	var jobs []job
	for _, it := range plan.Items {
		if it.KeepPDF {
			jobs = append(jobs, job{slot: len(jobs), pdf: true, orig: it.OriginalIndex, pages: len(it.Pages)})
			continue
		}
		for _, p := range it.Pages {
			jobs = append(jobs, job{slot: len(jobs), page: p})
		}
	}
	results := make([]*FileResult, len(jobs))
	errs := make([]error, len(jobs))
	// One page at a time: each AVIF encode holds ~250MB (WASM) and takes ~1s, which still finishes
	// well inside the time the vision request takes.
	sem := make(chan struct{}, 1)
	var wg sync.WaitGroup
	for _, j := range jobs {
		wg.Add(1)
		sem <- struct{}{}
		go func(j job) {
			defer wg.Done()
			defer func() { <-sem }()
			if j.pdf {
				o := in.Originals[j.orig]
				name := safePDFName(o.Filename, j.orig)
				up, err := s.up.UploadFile(ctx, in.Auth, name, "application/pdf", o.Data, extractionID)
				if err != nil {
					errs[j.slot] = err
					return
				}
				pc := j.pages
				results[j.slot] = &FileResult{FileID: up.ID, Kind: "pdf", ContentType: "application/pdf", PageCount: &pc, Size: int64(len(o.Data))}
				return
			}
			avif, err := imgstore.EncodeAVIF(in.Pages[j.page], 60)
			if err != nil {
				errs[j.slot] = err
				return
			}
			up, err := s.up.UploadFile(ctx, in.Auth, fmt.Sprintf("p%d.avif", j.page+1), "image/avif", avif, extractionID)
			if err != nil {
				errs[j.slot] = err
				return
			}
			pg := j.page + 1
			results[j.slot] = &FileResult{FileID: up.ID, Kind: "image", ContentType: "image/avif", Page: &pg, Size: int64(len(avif))}
		}(j)
	}
	wg.Wait()
	var out []FileResult
	var warnings []string
	for i := range jobs {
		if errs[i] != nil {
			logf("archive failed: %v", errs[i])
			continue
		}
		out = append(out, *results[i])
	}
	if len(out) < len(jobs) {
		warnings = append(warnings, fmt.Sprintf("Không lưu được %d/%d tệp hóa đơn gốc; phiếu nhập sẽ thiếu bản lưu", len(jobs)-len(out), len(jobs)))
	}
	return out, warnings
}

func safePDFName(name string, idx int) string {
	name = filepath.Base(strings.TrimSpace(name))
	if name == "" || name == "." || name == "/" || name == "\\" {
		return fmt.Sprintf("invoice-%d.pdf", idx+1)
	}
	return name
}

// ---- vision read ----

func (s *Service) readInvoice(ctx context.Context, in ExtractInput, onUsage func(deepseek.Usage)) (invoice.RawInvoice, error) {
	parts := []deepseek.ContentPart{{Type: "text", Text: fmt.Sprintf("Purchase invoice with %d page image(s), in page order. Return the json object.", len(in.Pages))}}
	for _, p := range in.Pages {
		parts = append(parts, deepseek.ContentPart{Type: "image_url", ImageURL: &deepseek.ImageURL{URL: "data:image/jpeg;base64," + base64.StdEncoding.EncodeToString(p)}})
	}
	if t := strings.TrimSpace(in.PDFText); t != "" {
		parts = append(parts, deepseek.ContentPart{Type: "text", Text: "pdf_text (text layer of the PDF, reliable for numbers):\n" + t})
	}
	zero := 0.0
	resp, err := s.ds.Chat(ctx, deepseek.Request{
		Model: s.cfg.DeepSeekVisionModel,
		Messages: []deepseek.Message{
			{Role: "system", Content: prompts.ExtractionSystem},
			{Role: "user", Content: parts},
		},
		ResponseFormat: map[string]string{"type": "json_object"},
		Thinking:       map[string]string{"type": "disabled"},
		Temperature:    &zero,
		MaxTokens:      8192,
	})
	if err != nil {
		logf("vision request failed: %v", err)
		return invoice.RawInvoice{}, newErr(http.StatusBadGateway, "Không gọi được dịch vụ AI, vui lòng thử lại hoặc nhập tay")
	}
	onUsage(resp.Usage)
	var raw invoice.RawInvoice
	if err := json.Unmarshal([]byte(extractJSON(resp.Text())), &raw); err != nil {
		logf("vision response not json: %v", err)
		return invoice.RawInvoice{}, newErr(http.StatusBadGateway, "AI trả về dữ liệu không hợp lệ, vui lòng thử lại")
	}
	return raw, nil
}

// extractJSON strips markdown fences / chatter around the first JSON object.
func extractJSON(s string) string {
	s = strings.TrimSpace(s)
	i, j := strings.Index(s, "{"), strings.LastIndex(s, "}")
	if i >= 0 && j > i {
		return s[i : j+1]
	}
	return s
}

// ---- matching ----

type lineMatch struct {
	Product    invoice.Product
	UnitID     string
	Confidence float64
	Source     string
	Reason     string
}

func (s *Service) matchLines(ctx context.Context, in ExtractInput, sup invoice.SupplierMatch, h invoice.Header, lines []invoice.Line, onUsage func(deepseek.Usage)) (map[int]lineMatch, []string) {
	out := map[int]lineMatch{}
	var warnings []string
	var pending []invoice.Line
	cache := map[string]*invoice.Product{}

	for _, l := range lines {
		if sup.Matched {
			if hit, ok := s.lookupMapping(ctx, sup.SupplierID, textutil.Fold(l.RawName), textutil.Fold(l.RawUnit)); ok {
				p, cached := cache[hit.ProductID]
				if !cached {
					if prod, err := s.up.ProductByID(ctx, in.Auth, hit.ProductID); err == nil {
						p = &prod
					}
					cache[hit.ProductID] = p
				}
				if p != nil {
					out[l.Index] = lineMatch{Product: *p, UnitID: hit.UnitID, Confidence: 1, Source: "memory", Reason: "Đã xác nhận ở lần nhập trước"}
					continue
				}
			}
		}
		pending = append(pending, l)
	}
	if len(pending) == 0 {
		return out, warnings
	}
	supplierName := h.SupplierName
	if sup.Matched {
		supplierName = sup.Name
	}
	tools := agentTools{up: s.up, auth: in.Auth}
	cands := s.retrieveCandidates(ctx, tools, h.SupplierName, pending)
	r, err := agent.Run(ctx, s.ds, s.cfg.DeepSeekAgentModel, supplierName, pending, cands, tools, onUsage)
	if err != nil {
		logf("agent failed: %v", err)
		warnings = append(warnings, "Không ghép được thuốc tự động, hãy chọn thuốc thủ công")
	}
	for idx, m := range r.Matches {
		if m.Product == nil {
			continue
		}
		out[idx] = lineMatch{Product: *m.Product, UnitID: m.UnitID, Confidence: m.Confidence, Source: "agent", Reason: m.Reason}
	}
	for _, l := range pending {
		if _, ok := out[l.Index]; ok {
			continue
		}
		if c, ok := invoice.FuzzyPick(cands[l.Index]); ok {
			out[l.Index] = lineMatch{Product: c.Product, Confidence: invoice.FuzzyConfidence(c.Score), Source: "fuzzy", Reason: "Khớp gần đúng theo tên (bỏ dấu)"}
		}
	}
	return out, warnings
}

// retrieveCandidates fetches catalog products for the queries derived from every pending line (each
// distinct query once per invoice) and ranks them per line by accent-insensitive name similarity.
func (s *Service) retrieveCandidates(ctx context.Context, tools agent.Tools, supplierName string, pending []invoice.Line) map[int][]invoice.Candidate {
	brand := invoice.DistinctTokens(supplierName)
	perLine := make([][]string, len(pending))
	for i, l := range pending {
		perLine[i] = invoice.DeriveQueries(l.RawName, brand)
	}
	found := map[string]invoice.Product{}
	var order []string
	for _, q := range invoice.DedupeQueries(perLine) {
		products, err := tools.SearchProducts(ctx, q, 20)
		if err != nil {
			logf("candidate search %q failed: %v", q, err)
			continue
		}
		for _, p := range products {
			if _, dup := found[p.ID]; !dup {
				found[p.ID] = p
				order = append(order, p.ID)
			}
		}
	}
	all := make([]invoice.Product, 0, len(order))
	for _, id := range order {
		all = append(all, found[id])
	}
	out := map[int][]invoice.Candidate{}
	for _, l := range pending {
		if cs := invoice.RankCandidates(l.RawName, brand, all, invoice.MaxCandidates); len(cs) > 0 {
			out[l.Index] = cs
		}
	}
	return out
}

// ---- mappings ----

var errNoSupplier = errors.New("supplier_id is required")

func (s *Service) SaveMappings(ctx context.Context, supplierID string, items []MappingItem) error {
	supplierID = strings.TrimSpace(supplierID)
	if supplierID == "" {
		return errNoSupplier
	}
	valid := make([]MappingItem, 0, len(items))
	for _, it := range items {
		if strings.TrimSpace(it.RawName) == "" || strings.TrimSpace(it.ProductID) == "" {
			continue
		}
		valid = append(valid, it)
	}
	if len(valid) == 0 {
		return nil
	}
	return s.upsertMappings(ctx, supplierID, valid, textutil.Fold)
}

func IsNoSupplier(err error) bool { return errors.Is(err, errNoSupplier) }
