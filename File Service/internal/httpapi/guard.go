package httpapi

import (
	"errors"
	"io"
	"mime"
	"net/http"
	"strings"

	"file-service/internal/app"
	"file-service/internal/auth"
	"file-service/internal/domain"
)

// ownerMaxUploadBytes is the request cap for owner-level callers. The Store service
// pushes whole-database dumps with an owner token, which can legitimately be larger
// than MAX_UPLOAD_SIZE_MB (that cap still applies to every other caller).
const ownerMaxUploadBytes int64 = 1 << 30

// unsafeContentTypes would be rendered/executed by a browser if served inline.
var unsafeContentTypes = map[string]bool{
	"text/html":                true,
	"application/xhtml+xml":    true,
	"image/svg+xml":            true,
	"text/xml":                 true,
	"application/xml":          true,
	"application/javascript":   true,
	"application/x-javascript": true,
	"text/javascript":          true,
	"application/ecmascript":   true,
	"text/ecmascript":          true,
}

// safeContentType maps browser-executable media types to application/octet-stream.
func safeContentType(contentType string) string {
	contentType = strings.TrimSpace(contentType)
	if contentType == "" {
		return "application/octet-stream"
	}
	mediaType, _, err := mime.ParseMediaType(contentType)
	if err != nil {
		mediaType = strings.ToLower(strings.TrimSpace(strings.SplitN(contentType, ";", 2)[0]))
	}
	if unsafeContentTypes[strings.ToLower(mediaType)] {
		return "application/octet-stream"
	}
	return contentType
}

// sniffContentType detects the content type from the first bytes of the upload instead of
// trusting the client header, and rewinds the reader. http.DetectContentType does not know
// AVIF, so that brand is checked explicitly; when sniffing only finds a generic type, a declared
// image/*, application/pdf or video/* type that is not browser-executable is kept.
func sniffContentType(f io.ReadSeeker, declared string) (string, error) {
	buf := make([]byte, 512)
	n, err := io.ReadFull(f, buf)
	if err != nil && !errors.Is(err, io.EOF) && !errors.Is(err, io.ErrUnexpectedEOF) {
		return "", err
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return "", err
	}
	buf = buf[:n]

	if n >= 12 && string(buf[4:8]) == "ftyp" && (string(buf[8:12]) == "avif" || string(buf[8:12]) == "avis") {
		return "image/avif", nil
	}

	sniffed := http.DetectContentType(buf)
	detected := safeContentType(sniffed)
	// Only a generic sniff result may be overridden; content sniffed as HTML/XML/JS never is.
	if sniffed == "application/octet-stream" || strings.HasPrefix(sniffed, "text/plain") {
		kept := safeContentType(declared)
		mediaType, _, perr := mime.ParseMediaType(kept)
		if perr == nil {
			mediaType = strings.ToLower(mediaType)
			if strings.HasPrefix(mediaType, "image/") || strings.HasPrefix(mediaType, "video/") || mediaType == "application/pdf" {
				return kept, nil
			}
		}
	}
	return detected, nil
}

func isBackupRequest(category, refType string) bool {
	return strings.EqualFold(strings.TrimSpace(category), domain.CategoryBackup) ||
		strings.EqualFold(strings.TrimSpace(refType), app.BackupRefType)
}

func isBackupKey(r2Key string) bool {
	return strings.HasPrefix(strings.ToLower(strings.TrimLeft(strings.TrimSpace(r2Key), "/")), domain.CategoryBackup+"/")
}

// denyBackupAccess writes 403 and returns true when a non-owner touches backup data.
func denyBackupAccess(w http.ResponseWriter, r *http.Request) bool {
	if auth.IsOwner(r.Context()) {
		return false
	}
	writeError(w, http.StatusForbidden, "Only owner/admin can access backups")
	return true
}

// limitUploadBody applies a real total cap to the request body before multipart parsing.
func (h *Handler) limitUploadBody(w http.ResponseWriter, r *http.Request) {
	limit := h.cfg.MaxUploadSize
	if auth.IsOwner(r.Context()) && limit < ownerMaxUploadBytes {
		limit = ownerMaxUploadBytes
	}
	r.Body = http.MaxBytesReader(w, r.Body, limit)
}

func writeMultipartError(w http.ResponseWriter, err error, tooLargeMsg string) {
	var tooLarge *http.MaxBytesError
	if errors.As(err, &tooLarge) {
		writeError(w, http.StatusRequestEntityTooLarge, tooLargeMsg)
		return
	}
	writeError(w, http.StatusBadRequest, "File too large or invalid multipart form")
}
