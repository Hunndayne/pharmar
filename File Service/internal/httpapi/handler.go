package httpapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"

	"file-service/internal/app"
	"file-service/internal/auth"
	"file-service/internal/config"
)

type Handler struct {
	cfg config.Config
	svc *app.Service
}

func NewHandler(cfg config.Config, svc *app.Service) http.Handler {
	handler := &Handler{
		cfg: cfg,
		svc: svc,
	}
	return handler.routes()
}

func (h *Handler) routes() http.Handler {
	r := chi.NewRouter()
	r.Use(middleware.RequestID)
	r.Use(middleware.RealIP)
	r.Use(middleware.Logger)
	r.Use(corsMiddleware(h.cfg.CORSAllowedOrigins))

	r.Get("/health", h.health)

	r.Route("/api/v1/file", func(r chi.Router) {
		r.Get("/health", h.health)

		// Upload — requires authentication
		r.With(auth.Authenticated(h.cfg)).Post("/upload", h.uploadFile)
		r.With(auth.Authenticated(h.cfg)).Post("/upload/multiple", h.uploadMultiple)

		// Presigned URLs — requires authentication
		r.With(auth.Authenticated(h.cfg)).Post("/presign/upload", h.presignUpload)
		r.With(auth.Authenticated(h.cfg)).Post("/presign/confirm", h.confirmPresignedUpload)
		r.With(auth.Authenticated(h.cfg)).Get("/presign/download/{fileID}", h.presignDownload)

		// List & get — requires authentication
		r.With(auth.Authenticated(h.cfg)).Get("/list", h.listFiles)
		r.With(auth.Authenticated(h.cfg)).Get("/{fileID}", h.getFile)

		// Delete — owner only
		r.With(auth.OwnerOnly(h.cfg)).Delete("/{fileID}", h.deleteFile)
		r.With(auth.OwnerOnly(h.cfg)).Delete("/ref/{refType}/{refID}", h.deleteByRef)
	})

	return r
}

func (h *Handler) health(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{
		"service": "file-service",
		"status":  "ok",
	})
}

// ---- Upload Handlers ----

func (h *Handler) uploadFile(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseMultipartForm(h.cfg.MaxUploadSize); err != nil {
		writeError(w, http.StatusBadRequest, "File too large or invalid multipart form")
		return
	}

	file, header, err := r.FormFile("file")
	if err != nil {
		writeError(w, http.StatusBadRequest, "Missing 'file' field")
		return
	}
	defer file.Close()

	category := strings.TrimSpace(r.FormValue("category"))
	refType := strings.TrimSpace(r.FormValue("ref_type"))
	refID := strings.TrimSpace(r.FormValue("ref_id"))

	contentType := header.Header.Get("Content-Type")
	if contentType == "" {
		contentType = "application/octet-stream"
	}

	actor := actorFromRequest(r)

	rec, err := h.svc.Upload(r.Context(), file, header.Filename, contentType, category, refType, refID, actor)
	if err != nil {
		h.handleServiceError(w, err)
		return
	}

	// Update size after upload
	_ = h.svc.UpdateFileSize(r.Context(), rec.ID, header.Size)
	rec.Size = header.Size

	writeJSON(w, http.StatusCreated, rec)
}

func (h *Handler) uploadMultiple(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseMultipartForm(h.cfg.MaxUploadSize); err != nil {
		writeError(w, http.StatusBadRequest, "Files too large or invalid multipart form")
		return
	}

	files := r.MultipartForm.File["files"]
	if len(files) == 0 {
		writeError(w, http.StatusBadRequest, "No files provided in 'files' field")
		return
	}

	category := strings.TrimSpace(r.FormValue("category"))
	refType := strings.TrimSpace(r.FormValue("ref_type"))
	refID := strings.TrimSpace(r.FormValue("ref_id"))
	actor := actorFromRequest(r)

	var results []any
	var uploadErrors []string

	for _, fh := range files {
		file, err := fh.Open()
		if err != nil {
			uploadErrors = append(uploadErrors, fmt.Sprintf("%s: %v", fh.Filename, err))
			continue
		}

		contentType := fh.Header.Get("Content-Type")
		if contentType == "" {
			contentType = "application/octet-stream"
		}

		rec, err := h.svc.Upload(r.Context(), file, fh.Filename, contentType, category, refType, refID, actor)
		file.Close()
		if err != nil {
			uploadErrors = append(uploadErrors, fmt.Sprintf("%s: %v", fh.Filename, err))
			continue
		}

		_ = h.svc.UpdateFileSize(r.Context(), rec.ID, fh.Size)
		rec.Size = fh.Size
		results = append(results, rec)
	}

	status := http.StatusCreated
	if len(uploadErrors) > 0 && len(results) == 0 {
		status = http.StatusBadRequest
	} else if len(uploadErrors) > 0 {
		status = http.StatusMultiStatus
	}

	writeJSON(w, status, map[string]any{
		"files":  results,
		"errors": uploadErrors,
		"total":  len(results),
	})
}

// ---- Presigned URL Handlers ----

type presignUploadRequest struct {
	Filename    string `json:"filename"`
	ContentType string `json:"content_type"`
	Category    string `json:"category"`
}

func (h *Handler) presignUpload(w http.ResponseWriter, r *http.Request) {
	var req presignUploadRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "Invalid JSON body")
		return
	}

	if strings.TrimSpace(req.Filename) == "" {
		writeError(w, http.StatusBadRequest, "filename is required")
		return
	}
	if strings.TrimSpace(req.ContentType) == "" {
		req.ContentType = "application/octet-stream"
	}

	presigned, r2Key, err := h.svc.GetPresignedUploadURL(r.Context(), req.Filename, req.ContentType, req.Category)
	if err != nil {
		h.handleServiceError(w, err)
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"upload_url": presigned.URL,
		"r2_key":     r2Key,
		"expires_in": presigned.ExpiresIn,
	})
}

type confirmUploadRequest struct {
	Filename    string `json:"filename"`
	ContentType string `json:"content_type"`
	R2Key       string `json:"r2_key"`
	Category    string `json:"category"`
	RefType     string `json:"ref_type"`
	RefID       string `json:"ref_id"`
	Size        int64  `json:"size"`
}

func (h *Handler) confirmPresignedUpload(w http.ResponseWriter, r *http.Request) {
	var req confirmUploadRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "Invalid JSON body")
		return
	}

	if strings.TrimSpace(req.Filename) == "" || strings.TrimSpace(req.R2Key) == "" {
		writeError(w, http.StatusBadRequest, "filename and r2_key are required")
		return
	}
	if strings.TrimSpace(req.ContentType) == "" {
		req.ContentType = "application/octet-stream"
	}

	actor := actorFromRequest(r)

	rec, err := h.svc.ConfirmUpload(r.Context(), req.Filename, req.ContentType, req.R2Key, req.Category, req.RefType, req.RefID, actor, req.Size)
	if err != nil {
		h.handleServiceError(w, err)
		return
	}

	writeJSON(w, http.StatusCreated, rec)
}

func (h *Handler) presignDownload(w http.ResponseWriter, r *http.Request) {
	fileID := chi.URLParam(r, "fileID")
	if fileID == "" {
		writeError(w, http.StatusBadRequest, "fileID is required")
		return
	}

	presigned, err := h.svc.GetPresignedDownloadURL(r.Context(), fileID)
	if err != nil {
		h.handleServiceError(w, err)
		return
	}

	writeJSON(w, http.StatusOK, presigned)
}

// ---- List & Get Handlers ----

func (h *Handler) listFiles(w http.ResponseWriter, r *http.Request) {
	category := r.URL.Query().Get("category")
	refType := r.URL.Query().Get("ref_type")
	refID := r.URL.Query().Get("ref_id")
	search := r.URL.Query().Get("search")
	page, _ := strconv.Atoi(r.URL.Query().Get("page"))
	perPage, _ := strconv.Atoi(r.URL.Query().Get("per_page"))

	result, err := h.svc.ListFiles(r.Context(), category, refType, refID, search, page, perPage)
	if err != nil {
		h.handleServiceError(w, err)
		return
	}

	writeJSON(w, http.StatusOK, result)
}

func (h *Handler) getFile(w http.ResponseWriter, r *http.Request) {
	fileID := chi.URLParam(r, "fileID")
	if fileID == "" {
		writeError(w, http.StatusBadRequest, "fileID is required")
		return
	}

	rec, err := h.svc.GetFile(r.Context(), fileID)
	if err != nil {
		h.handleServiceError(w, err)
		return
	}

	writeJSON(w, http.StatusOK, rec)
}

// ---- Delete Handlers ----

func (h *Handler) deleteFile(w http.ResponseWriter, r *http.Request) {
	fileID := chi.URLParam(r, "fileID")
	if fileID == "" {
		writeError(w, http.StatusBadRequest, "fileID is required")
		return
	}

	if err := h.svc.DeleteFile(r.Context(), fileID); err != nil {
		h.handleServiceError(w, err)
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"message": "file deleted"})
}

func (h *Handler) deleteByRef(w http.ResponseWriter, r *http.Request) {
	refType := chi.URLParam(r, "refType")
	refID := chi.URLParam(r, "refID")
	if refType == "" || refID == "" {
		writeError(w, http.StatusBadRequest, "refType and refID are required")
		return
	}

	count, err := h.svc.DeleteByRef(r.Context(), refType, refID)
	if err != nil {
		h.handleServiceError(w, err)
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"message": fmt.Sprintf("%d file(s) deleted", count),
		"deleted": count,
	})
}

// ---- Helpers ----

func (h *Handler) handleServiceError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, app.ErrBadRequest):
		writeError(w, http.StatusBadRequest, err.Error())
	case errors.Is(err, app.ErrNotFound):
		writeError(w, http.StatusNotFound, err.Error())
	case errors.Is(err, app.ErrForbidden):
		writeError(w, http.StatusForbidden, err.Error())
	default:
		writeError(w, http.StatusInternalServerError, "Internal server error")
	}
}

func actorFromRequest(r *http.Request) string {
	claims, ok := auth.ClaimsFromContext(r.Context())
	if ok && claims.Subject != "" {
		return claims.Subject
	}
	return "unknown"
}
