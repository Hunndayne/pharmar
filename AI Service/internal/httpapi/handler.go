package httpapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"mime/multipart"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"

	"ai-service/internal/app"
	"ai-service/internal/auth"
	"ai-service/internal/config"
	"ai-service/internal/imgstore"
)

const (
	maxPages        = 10
	maxPageBytes    = 4 << 20
	maxOriginals    = 10
	maxOriginalSize = 10 << 20
	maxPDFTextChars = 50000
	maxBodyBytes    = maxPages*maxPageBytes + maxOriginals*maxOriginalSize + (2 << 20)
	maxMappingItems = 200
)

type Handler struct {
	cfg config.Config
	svc *app.Service
}

func NewHandler(cfg config.Config, svc *app.Service) http.Handler {
	h := &Handler{cfg: cfg, svc: svc}
	return h.routes()
}

func (h *Handler) routes() http.Handler {
	r := chi.NewRouter()
	r.Use(middleware.RequestID)
	r.Use(middleware.RealIP)
	r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)
	r.Use(corsMiddleware(h.cfg.CORSAllowedOrigins))

	r.Get("/health", h.health)

	r.Route("/api/v1/ai", func(r chi.Router) {
		r.Get("/health", h.health)
		r.Group(func(r chi.Router) {
			r.Use(auth.Authenticated(h.cfg))
			r.Post("/purchase-invoices/extract", h.extract)
			r.Post("/purchase-invoices/mappings", h.saveMappings)
			r.Get("/usage/today", h.usageToday)
		})
	})
	return r
}

func (h *Handler) health(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"service": "ai-service", "status": "ok", "ai_enabled": h.cfg.AIEnabled()})
}

func (h *Handler) writeServiceError(w http.ResponseWriter, err error) {
	var ae *app.Error
	if errors.As(err, &ae) {
		writeError(w, ae.Status, ae.Detail)
		return
	}
	log.Printf("internal error: %v", err)
	writeError(w, http.StatusInternalServerError, "Lỗi hệ thống, vui lòng thử lại")
}

func (h *Handler) extract(w http.ResponseWriter, r *http.Request) {
	if !h.cfg.AIEnabled() {
		writeError(w, http.StatusServiceUnavailable, "Chưa cấu hình AI")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxBodyBytes)
	if err := r.ParseMultipartForm(32 << 20); err != nil {
		writeError(w, http.StatusBadRequest, "Dữ liệu tải lên quá lớn hoặc không hợp lệ")
		return
	}
	defer r.MultipartForm.RemoveAll()

	pageHeaders := r.MultipartForm.File["pages"]
	if len(pageHeaders) == 0 {
		writeError(w, http.StatusBadRequest, "Thiếu ảnh trang hóa đơn (pages)")
		return
	}
	if len(pageHeaders) > maxPages {
		writeError(w, http.StatusBadRequest, fmt.Sprintf("Tối đa %d trang mỗi lần đọc", maxPages))
		return
	}
	in := app.ExtractInput{Auth: r.Header.Get("Authorization")}
	if claims, ok := auth.ClaimsFromContext(r.Context()); ok {
		in.UserID = claims.Subject
	}
	for i, fh := range pageHeaders {
		if fh.Size > maxPageBytes {
			writeError(w, http.StatusBadRequest, fmt.Sprintf("Trang %d vượt quá 4 MB", i+1))
			return
		}
		data, err := readPart(fh)
		if err != nil {
			writeError(w, http.StatusBadRequest, "Không đọc được tệp tải lên")
			return
		}
		if !imgstore.IsJPEG(data) {
			writeError(w, http.StatusBadRequest, fmt.Sprintf("Trang %d không phải ảnh JPEG", i+1))
			return
		}
		in.Pages = append(in.Pages, data)
	}
	origHeaders := r.MultipartForm.File["originals"]
	if len(origHeaders) > maxOriginals {
		writeError(w, http.StatusBadRequest, fmt.Sprintf("Tối đa %d tệp PDF gốc", maxOriginals))
		return
	}
	for i, fh := range origHeaders {
		if fh.Size > maxOriginalSize {
			writeError(w, http.StatusBadRequest, fmt.Sprintf("Tệp PDF gốc %d vượt quá 10 MB", i+1))
			return
		}
		data, err := readPart(fh)
		if err != nil {
			writeError(w, http.StatusBadRequest, "Không đọc được tệp tải lên")
			return
		}
		if !imgstore.IsPDF(data) {
			writeError(w, http.StatusBadRequest, fmt.Sprintf("Tệp gốc %d không phải PDF", i+1))
			return
		}
		in.Originals = append(in.Originals, app.Original{Filename: fh.Filename, Data: data})
	}

	rawSources := strings.TrimSpace(r.FormValue("sources"))
	if rawSources == "" {
		writeError(w, http.StatusBadRequest, "Thiếu trường sources")
		return
	}
	if err := json.Unmarshal([]byte(rawSources), &in.Sources); err != nil || len(in.Sources) == 0 {
		writeError(w, http.StatusBadRequest, "Trường sources không phải JSON hợp lệ")
		return
	}
	pdfText := r.FormValue("pdf_text")
	if n := len([]rune(pdfText)); n > maxPDFTextChars {
		writeError(w, http.StatusBadRequest, fmt.Sprintf("pdf_text vượt quá %d ký tự", maxPDFTextChars))
		return
	}
	in.PDFText = pdfText

	res, err := h.svc.Extract(r.Context(), in)
	if err != nil {
		h.writeServiceError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

func readPart(fh *multipart.FileHeader) ([]byte, error) {
	f, err := fh.Open()
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return io.ReadAll(f)
}

func (h *Handler) saveMappings(w http.ResponseWriter, r *http.Request) {
	var body struct {
		SupplierID string            `json:"supplier_id"`
		Items      []app.MappingItem `json:"items"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "Dữ liệu không hợp lệ")
		return
	}
	if len(body.Items) > maxMappingItems {
		writeError(w, http.StatusBadRequest, fmt.Sprintf("Tối đa %d dòng mỗi lần", maxMappingItems))
		return
	}
	if err := h.svc.SaveMappings(r.Context(), body.SupplierID, body.Items); err != nil {
		if app.IsNoSupplier(err) {
			writeError(w, http.StatusBadRequest, "Thiếu supplier_id")
			return
		}
		h.writeServiceError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) usageToday(w http.ResponseWriter, r *http.Request) {
	u, err := h.svc.UsageToday(r.Context())
	if err != nil {
		h.writeServiceError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, u)
}
