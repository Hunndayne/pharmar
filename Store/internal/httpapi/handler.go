package httpapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
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
	r.Use(corsMiddleware)

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

func (h *Handler) uploadLogo(w http.ResponseWriter, r *http.Request) {
	const maxUploadSize = int64(10 << 20) // 10MB
	r.Body = http.MaxBytesReader(w, r.Body, maxUploadSize)

	if err := r.ParseMultipartForm(maxUploadSize); err != nil {
		writeError(w, http.StatusBadRequest, "Invalid multipart form")
		return
	}

	file, header, err := r.FormFile("file")
	if err != nil {
		writeError(w, http.StatusBadRequest, "Missing logo file in form field 'file'")
		return
	}
	defer file.Close()

	info, err := h.svc.SaveLogo(r.Context(), file, header.Filename)
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

func (h *Handler) handleServiceError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, app.ErrBadRequest):
		writeError(w, http.StatusBadRequest, err.Error())
	case errors.Is(err, app.ErrNotFound):
		writeError(w, http.StatusNotFound, err.Error())
	default:
		writeError(w, http.StatusInternalServerError, "Internal server error")
	}
}

func getActorSubject(r *http.Request) string {
	claims, ok := auth.ClaimsFromContext(r.Context())
	if !ok {
		return ""
	}
	return claims.Subject
}

func decodeJSON(r *http.Request, dst any) error {
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(dst); err != nil {
		return fmt.Errorf("invalid request body: %w", err)
	}
	return nil
}

func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Authorization,Content-Type")

		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusOK)
			return
		}

		next.ServeHTTP(w, r)
	})
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
