package httpapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"

	"store-service/internal/app"
	"store-service/internal/auth"
	"store-service/internal/config"
	"store-service/internal/domain"
)

type Handler struct {
	cfg config.Config
	svc *app.Service
}

type updateSettingRequest struct {
	Value any `json:"value"`
}

type bulkUpdateSettingsRequest struct {
	Settings map[string]any `json:"settings"`
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

	r.Route("/api/v1/store", func(r chi.Router) {
		r.Get("/health", h.health)
		fileServer(r, "/uploads", http.Dir(h.cfg.LogoUploadDir))

		r.Get("/info", h.getStoreInfo)
		r.With(auth.OwnerOnly(h.cfg)).Put("/info", h.updateStoreInfo)
		r.With(auth.OwnerOnly(h.cfg)).Post("/info/logo", h.uploadLogo)
		r.With(auth.OwnerOnly(h.cfg)).Delete("/info/logo", h.deleteLogo)

		r.Get("/settings", h.getAllSettings)
		r.Get("/settings/group/{group}", h.getSettingsByGroup)
		r.Get("/settings/{key}", h.getSetting)
		r.With(auth.OwnerOnly(h.cfg)).Put("/settings/{key}", h.updateSetting)
		r.With(auth.OwnerOnly(h.cfg)).Put("/settings", h.updateSettingsBulk)
		r.With(auth.OwnerOnly(h.cfg)).Post("/settings/reset", h.resetAllSettings)
		r.With(auth.OwnerOnly(h.cfg)).Post("/settings/reset/{key}", h.resetSetting)

		r.Get("/drug-categories", h.listDrugCategories)
		r.With(auth.OwnerOnly(h.cfg)).Post("/drug-categories", h.createDrugCategory)
		r.With(auth.OwnerOnly(h.cfg)).Put("/drug-categories/{categoryID}", h.updateDrugCategory)
		r.With(auth.OwnerOnly(h.cfg)).Delete("/drug-categories/{categoryID}", h.deleteDrugCategory)

		r.With(auth.OwnerOnly(h.cfg)).Post("/drug-groups", h.createDrugGroup)
		r.With(auth.OwnerOnly(h.cfg)).Put("/drug-groups/{groupID}", h.updateDrugGroup)
		r.With(auth.OwnerOnly(h.cfg)).Delete("/drug-groups/{groupID}", h.deleteDrugGroup)

		r.Route("/backup", func(r chi.Router) {
			r.With(auth.OwnerOnly(h.cfg)).Get("/list", h.listBackups)
			r.With(auth.OwnerOnly(h.cfg)).Post("/create", h.createBackup)
			r.With(auth.OwnerOnly(h.cfg)).Get("/download/{backupID}", h.downloadBackup)
			r.With(auth.OwnerOnly(h.cfg)).Delete("/{backupID}", h.deleteBackup)
			r.With(auth.OwnerOnly(h.cfg)).Post("/upload", h.uploadBackup)
			r.With(auth.OwnerOnly(h.cfg)).Post("/restore/{backupID}", h.restoreBackup)
			r.With(auth.OwnerOnly(h.cfg)).Post("/sync/push", h.syncPush)
			r.With(auth.OwnerOnly(h.cfg)).Post("/sync/pull", h.syncPull)
			// Sync endpoints - API key auth (no JWT)
			r.Post("/receive", h.receiveBackup)
			r.Get("/latest/download", h.downloadLatestBackup)
		})
	})

	return r
}

func (h *Handler) health(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{
		"service": "store",
		"status":  "ok",
	})
}

func (h *Handler) getStoreInfo(w http.ResponseWriter, r *http.Request) {
	info, err := h.svc.GetStoreInfo(r.Context())
	if err != nil {
		h.handleServiceError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, info)
}

func (h *Handler) updateStoreInfo(w http.ResponseWriter, r *http.Request) {
	var payload domain.UpdateStoreInfoRequest
	if err := decodeJSON(r, &payload); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	info, err := h.svc.UpdateStoreInfo(r.Context(), payload)
	if err != nil {
		h.handleServiceError(w, err)
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"message": "Store info updated",
		"data":    info,
	})
}

var allowedImageTypes = map[string]string{
	"image/jpeg": ".jpg",
	"image/png":  ".png",
	"image/gif":  ".gif",
	"image/webp": ".webp",
}

func (h *Handler) uploadLogo(w http.ResponseWriter, r *http.Request) {
	const maxUploadSize = int64(10 << 20) // 10MB
	r.Body = http.MaxBytesReader(w, r.Body, maxUploadSize)

	if err := r.ParseMultipartForm(maxUploadSize); err != nil {
		writeError(w, http.StatusBadRequest, "Invalid multipart form")
		return
	}

	file, _, err := r.FormFile("file")
	if err != nil {
		writeError(w, http.StatusBadRequest, "Missing logo file in form field 'file'")
		return
	}
	defer file.Close()

	// Detect MIME type via magic bytes (first 512 bytes)
	sniffBuf := make([]byte, 512)
	n, err := file.Read(sniffBuf)
	if err != nil && err != io.EOF {
		writeError(w, http.StatusBadRequest, "Failed to read file")
		return
	}
	detectedType := http.DetectContentType(sniffBuf[:n])
	ext, ok := allowedImageTypes[detectedType]
	if !ok {
		writeError(w, http.StatusBadRequest, "Only JPEG, PNG, GIF, and WebP images are allowed")
		return
	}

	// Reconstruct full reader from already-read bytes + remainder
	combined := io.MultiReader(bytes.NewReader(sniffBuf[:n]), file)

	info, err := h.svc.SaveLogo(r.Context(), combined, "logo"+ext)
	if err != nil {
		h.handleServiceError(w, err)
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"message":  "Logo uploaded",
		"logo_url": info.LogoURL,
		"data":     info,
	})
}

func (h *Handler) deleteLogo(w http.ResponseWriter, r *http.Request) {
	info, err := h.svc.DeleteLogo(r.Context())
	if err != nil {
		h.handleServiceError(w, err)
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"message": "Logo removed",
		"data":    info,
	})
}

func (h *Handler) getAllSettings(w http.ResponseWriter, r *http.Request) {
	settings, err := h.svc.GetAllSettings(r.Context())
	if err != nil {
		h.handleServiceError(w, err)
		return
	}

	writeJSON(w, http.StatusOK, settings)
}

func (h *Handler) getSetting(w http.ResponseWriter, r *http.Request) {
	key := chi.URLParam(r, "key")
	if strings.TrimSpace(key) == "" {
		writeError(w, http.StatusBadRequest, "setting key is required")
		return
	}

	setting, err := h.svc.GetSetting(r.Context(), key)
	if err != nil {
		h.handleServiceError(w, err)
		return
	}

	writeJSON(w, http.StatusOK, setting)
}

func (h *Handler) getSettingsByGroup(w http.ResponseWriter, r *http.Request) {
	group := chi.URLParam(r, "group")
	settings, err := h.svc.GetSettingsByGroup(r.Context(), group)
	if err != nil {
		h.handleServiceError(w, err)
		return
	}

	writeJSON(w, http.StatusOK, settings)
}

func (h *Handler) updateSetting(w http.ResponseWriter, r *http.Request) {
	key := chi.URLParam(r, "key")
	if strings.TrimSpace(key) == "" {
		writeError(w, http.StatusBadRequest, "setting key is required")
		return
	}

	var payload updateSettingRequest
	if err := decodeJSON(r, &payload); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	actor := getActorSubject(r)
	setting, err := h.svc.UpdateSetting(r.Context(), key, payload.Value, actor)
	if err != nil {
		h.handleServiceError(w, err)
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"message": "Setting updated",
		"key":     setting.Key,
		"value":   setting.Value,
	})
}

func (h *Handler) updateSettingsBulk(w http.ResponseWriter, r *http.Request) {
	var payload bulkUpdateSettingsRequest
	if err := decodeJSON(r, &payload); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	actor := getActorSubject(r)
	updated, err := h.svc.UpdateSettingsBulk(r.Context(), payload.Settings, actor)
	if err != nil {
		h.handleServiceError(w, err)
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"message": "Settings updated",
		"updated": updated,
	})
}

func (h *Handler) resetAllSettings(w http.ResponseWriter, r *http.Request) {
	actor := getActorSubject(r)
	updated, err := h.svc.ResetAllSettings(r.Context(), actor)
	if err != nil {
		h.handleServiceError(w, err)
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"message": "Settings reset to default",
		"updated": updated,
	})
}

func (h *Handler) resetSetting(w http.ResponseWriter, r *http.Request) {
	key := chi.URLParam(r, "key")
	if strings.TrimSpace(key) == "" {
		writeError(w, http.StatusBadRequest, "setting key is required")
		return
	}

	actor := getActorSubject(r)
	setting, err := h.svc.ResetSetting(r.Context(), key, actor)
	if err != nil {
		h.handleServiceError(w, err)
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"message": "Setting reset",
		"key":     setting.Key,
		"value":   setting.Value,
	})
}

func (h *Handler) listDrugCategories(w http.ResponseWriter, r *http.Request) {
	includeInactive := parseBoolQuery(r.URL.Query().Get("include_inactive"))
	search := strings.TrimSpace(r.URL.Query().Get("search"))

	items, err := h.svc.ListDrugCategories(r.Context(), includeInactive, search)
	if err != nil {
		h.handleServiceError(w, err)
		return
	}

	totalGroups := 0
	for _, item := range items {
		totalGroups += len(item.Groups)
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"items":            items,
		"total_categories": len(items),
		"total_groups":     totalGroups,
	})
}

func (h *Handler) createDrugCategory(w http.ResponseWriter, r *http.Request) {
	var payload domain.CreateDrugCategoryRequest
	if err := decodeJSON(r, &payload); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	category, err := h.svc.CreateDrugCategory(r.Context(), payload, getActorSubject(r))
	if err != nil {
		h.handleServiceError(w, err)
		return
	}

	responseItem := domain.DrugCategoryWithGroups{
		DrugCategory: category,
		Groups:       []domain.DrugGroup{},
	}

	writeJSON(w, http.StatusCreated, map[string]any{
		"message": "Drug category created",
		"data":    responseItem,
	})
}

func (h *Handler) updateDrugCategory(w http.ResponseWriter, r *http.Request) {
	categoryID := chi.URLParam(r, "categoryID")
	if strings.TrimSpace(categoryID) == "" {
		writeError(w, http.StatusBadRequest, "categoryID is required")
		return
	}

	var payload domain.UpdateDrugCategoryRequest
	if err := decodeJSON(r, &payload); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	category, err := h.svc.UpdateDrugCategory(r.Context(), categoryID, payload, getActorSubject(r))
	if err != nil {
		h.handleServiceError(w, err)
		return
	}

	responseItem := domain.DrugCategoryWithGroups{
		DrugCategory: category,
		Groups:       []domain.DrugGroup{},
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"message": "Drug category updated",
		"data":    responseItem,
	})
}

func (h *Handler) deleteDrugCategory(w http.ResponseWriter, r *http.Request) {
	categoryID := chi.URLParam(r, "categoryID")
	if strings.TrimSpace(categoryID) == "" {
		writeError(w, http.StatusBadRequest, "categoryID is required")
		return
	}

	if err := h.svc.DeleteDrugCategory(r.Context(), categoryID); err != nil {
		h.handleServiceError(w, err)
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"message": "Drug category deleted",
		"id":      categoryID,
	})
}

func (h *Handler) createDrugGroup(w http.ResponseWriter, r *http.Request) {
	var payload domain.CreateDrugGroupRequest
	if err := decodeJSON(r, &payload); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	group, err := h.svc.CreateDrugGroup(r.Context(), payload, getActorSubject(r))
	if err != nil {
		h.handleServiceError(w, err)
		return
	}

	writeJSON(w, http.StatusCreated, map[string]any{
		"message": "Drug group created",
		"data":    group,
	})
}

func (h *Handler) updateDrugGroup(w http.ResponseWriter, r *http.Request) {
	groupID := chi.URLParam(r, "groupID")
	if strings.TrimSpace(groupID) == "" {
		writeError(w, http.StatusBadRequest, "groupID is required")
		return
	}

	var payload domain.UpdateDrugGroupRequest
	if err := decodeJSON(r, &payload); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	group, err := h.svc.UpdateDrugGroup(r.Context(), groupID, payload, getActorSubject(r))
	if err != nil {
		h.handleServiceError(w, err)
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"message": "Drug group updated",
		"data":    group,
	})
}

func (h *Handler) deleteDrugGroup(w http.ResponseWriter, r *http.Request) {
	groupID := chi.URLParam(r, "groupID")
	if strings.TrimSpace(groupID) == "" {
		writeError(w, http.StatusBadRequest, "groupID is required")
		return
	}

	if err := h.svc.DeleteDrugGroup(r.Context(), groupID); err != nil {
		h.handleServiceError(w, err)
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"message": "Drug group deleted",
		"id":      groupID,
	})
}

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

// --- Backup handlers ---

func (h *Handler) listBackups(w http.ResponseWriter, r *http.Request) {
	records, err := h.svc.ListBackups(r.Context())
	if err != nil {
		h.handleServiceError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"items":       records,
		"total":       len(records),
		"pg_dump_ok":  app.PgDumpAvailable(),
	})
}

func (h *Handler) createBackup(w http.ResponseWriter, r *http.Request) {
	if !app.PgDumpAvailable() {
		writeError(w, http.StatusServiceUnavailable, "pg_dump is not installed on this server")
		return
	}

	var payload struct {
		Note string `json:"note"`
	}
	_ = json.NewDecoder(r.Body).Decode(&payload)

	actor := getActorSubject(r)
	record, err := h.svc.CreateBackup(r.Context(), payload.Note, actor)
	if err != nil {
		h.handleServiceError(w, err)
		return
	}

	writeJSON(w, http.StatusCreated, map[string]any{
		"message": "Backup created",
		"data":    record,
	})
}

func (h *Handler) downloadBackup(w http.ResponseWriter, r *http.Request) {
	backupID := chi.URLParam(r, "backupID")
	filePath, filename, err := h.svc.GetBackupFilePath(r.Context(), backupID)
	if err != nil {
		h.handleServiceError(w, err)
		return
	}

	file, err := os.Open(filePath)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Failed to open backup file")
		return
	}
	defer file.Close()

	fi, err := file.Stat()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Failed to stat backup file")
		return
	}

	w.Header().Set("Content-Type", "application/gzip")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, filename))
	w.Header().Set("X-Backup-Filename", filename)
	http.ServeContent(w, r, filename, fi.ModTime(), file)
}

func (h *Handler) deleteBackup(w http.ResponseWriter, r *http.Request) {
	backupID := chi.URLParam(r, "backupID")
	if err := h.svc.DeleteBackup(r.Context(), backupID); err != nil {
		h.handleServiceError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"message": "Backup deleted",
		"id":      backupID,
	})
}

func (h *Handler) uploadBackup(w http.ResponseWriter, r *http.Request) {
	const maxUpload = int64(100 << 20) // 100 MB
	r.Body = http.MaxBytesReader(w, r.Body, maxUpload)

	if err := r.ParseMultipartForm(maxUpload); err != nil {
		writeError(w, http.StatusBadRequest, "Invalid multipart form or file too large")
		return
	}

	file, header, err := r.FormFile("file")
	if err != nil {
		writeError(w, http.StatusBadRequest, "Missing backup file in form field 'file'")
		return
	}
	defer file.Close()

	actor := getActorSubject(r)
	record, err := h.svc.SaveUploadedBackup(r.Context(), file, header.Filename, actor)
	if err != nil {
		h.handleServiceError(w, err)
		return
	}

	writeJSON(w, http.StatusCreated, map[string]any{
		"message": "Backup uploaded",
		"data":    record,
	})
}

func (h *Handler) restoreBackup(w http.ResponseWriter, r *http.Request) {
	backupID := chi.URLParam(r, "backupID")
	if err := h.svc.RestoreFromBackupID(r.Context(), backupID); err != nil {
		h.handleServiceError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"message": "Backup restored successfully",
	})
}

func (h *Handler) syncPush(w http.ResponseWriter, r *http.Request) {
	actor := getActorSubject(r)
	if err := h.svc.SyncPush(r.Context(), actor); err != nil {
		h.handleServiceError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"message": "Backup pushed to remote server",
	})
}

func (h *Handler) syncPull(w http.ResponseWriter, r *http.Request) {
	actor := getActorSubject(r)
	if err := h.svc.SyncPull(r.Context(), actor); err != nil {
		h.handleServiceError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"message": "Backup pulled from remote server",
	})
}

func (h *Handler) receiveBackup(w http.ResponseWriter, r *http.Request) {
	apiKey := strings.TrimSpace(r.Header.Get("X-Sync-API-Key"))
	filename := r.Header.Get("X-Backup-Filename")
	if filename == "" {
		filename = "received.sql.gz"
	}

	if err := h.svc.ReceiveBackup(r.Context(), apiKey, r.Body, filename); err != nil {
		h.handleServiceError(w, err)
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"message": "Backup received",
	})
}

func (h *Handler) downloadLatestBackup(w http.ResponseWriter, r *http.Request) {
	apiKey := strings.TrimSpace(r.Header.Get("X-Sync-API-Key"))
	expectedKey := h.svc.GetSyncAPIKeyPublic(r.Context())
	if expectedKey == "" || apiKey != expectedKey {
		writeError(w, http.StatusForbidden, "Invalid or missing sync API key")
		return
	}

	filePath, filename, err := h.svc.GetLatestBackupFilePath(r.Context())
	if err != nil {
		h.handleServiceError(w, err)
		return
	}

	file, err := os.Open(filePath)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Failed to open backup file")
		return
	}
	defer file.Close()

	fi, err := file.Stat()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Failed to stat backup file")
		return
	}

	w.Header().Set("Content-Type", "application/gzip")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, filename))
	w.Header().Set("X-Backup-Filename", filename)
	http.ServeContent(w, r, filename, fi.ModTime(), file)
}

func getActorSubject(r *http.Request) string {
	claims, ok := auth.ClaimsFromContext(r.Context())
	if !ok {
		return ""
	}
	return claims.Subject
}

func parseBoolQuery(raw string) bool {
	value := strings.TrimSpace(strings.ToLower(raw))
	return value == "1" || value == "true" || value == "yes"
}

func decodeJSON(r *http.Request, dst any) error {
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(dst); err != nil {
		return fmt.Errorf("invalid request body: %w", err)
	}
	return nil
}

func corsMiddleware(allowedOrigins []string) func(http.Handler) http.Handler {
	originSet := make(map[string]bool, len(allowedOrigins))
	for _, o := range allowedOrigins {
		originSet[strings.TrimSpace(o)] = true
	}

	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			origin := r.Header.Get("Origin")
			if origin != "" && originSet[origin] {
				w.Header().Set("Access-Control-Allow-Origin", origin)
				w.Header().Set("Access-Control-Allow-Credentials", "true")
				w.Header().Set("Vary", "Origin")
			}
			w.Header().Set("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Authorization,Content-Type,X-Requested-With,X-Sync-API-Key,X-Backup-Filename")

			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusOK)
				return
			}

			next.ServeHTTP(w, r)
		})
	}
}

func fileServer(r chi.Router, routePath string, root http.FileSystem) {
	if strings.ContainsAny(routePath, "{}*") {
		panic("file server does not permit URL parameters")
	}

	if routePath != "/" && routePath[len(routePath)-1] != '/' {
		r.Get(routePath, http.RedirectHandler(routePath+"/", http.StatusMovedPermanently).ServeHTTP)
		routePath += "/"
	}
	routePath += "*"

	r.Get(routePath, func(w http.ResponseWriter, r *http.Request) {
		routeContext := chi.RouteContext(r.Context())
		prefix := strings.TrimSuffix(routeContext.RoutePattern(), "/*")
		fileServer := http.StripPrefix(prefix, http.FileServer(root))
		fileServer.ServeHTTP(w, r)
	})
}
