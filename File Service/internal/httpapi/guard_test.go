package httpapi

import (
	"bytes"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"file-service/internal/config"
)

func testHandler() (*Handler, http.Handler) {
	cfg := config.Config{JWTSecretKey: "test-secret", JWTAlgorithm: "HS256", MaxUploadSize: 1024}
	h := &Handler{cfg: cfg}
	return h, h.routes()
}

func tokenFor(t *testing.T, role string) string {
	t.Helper()
	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
		"sub": "u1", "role": role, "type": "access",
		"exp": time.Now().Add(time.Hour).Unix(),
	})
	s, err := tok.SignedString([]byte("test-secret"))
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func multipartBody(t *testing.T, fields map[string]string, filename string, content []byte) (*bytes.Buffer, string) {
	t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	for k, v := range fields {
		_ = mw.WriteField(k, v)
	}
	fw, _ := mw.CreateFormFile("file", filename)
	_, _ = fw.Write(content)
	_ = mw.Close()
	return &buf, mw.FormDataContentType()
}

func TestSafeContentType(t *testing.T) {
	cases := map[string]string{
		"":                          "application/octet-stream",
		"text/html; charset=utf-8":  "application/octet-stream",
		"TEXT/HTML":                 "application/octet-stream",
		"image/svg+xml":             "application/octet-stream",
		"application/javascript":    "application/octet-stream",
		"text/xml; charset=utf-8":   "application/octet-stream",
		"image/png":                 "image/png",
		"text/plain; charset=utf-8": "text/plain; charset=utf-8",
		"application/x-gzip":        "application/x-gzip",
	}
	for in, want := range cases {
		if got := safeContentType(in); got != want {
			t.Errorf("safeContentType(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestSniffContentTypeIgnoresClientHeader(t *testing.T) {
	got, err := sniffContentType(strings.NewReader("<!DOCTYPE html><html><script>alert(1)</script></html>"), "text/html")
	if err != nil || got != "application/octet-stream" {
		t.Fatalf("html: got %q err %v", got, err)
	}
	r := strings.NewReader("hello world")
	got, _ = sniffContentType(r, "")
	if !strings.HasPrefix(got, "text/plain") {
		t.Fatalf("text: got %q", got)
	}
	rest := make([]byte, 11)
	if n, _ := r.Read(rest); n != 11 {
		t.Fatalf("reader not rewound, read %d", n)
	}
}

func TestNonOwnerCannotListOrUploadBackups(t *testing.T) {
	_, router := testHandler()
	staff := "Bearer " + tokenFor(t, "staff")

	for _, q := range []string{"?category=backup", "?category=BACKUP", "?ref_type=store_backup"} {
		req := httptest.NewRequest(http.MethodGet, "/api/v1/file/list"+q, nil)
		req.Header.Set("Authorization", staff)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusForbidden {
			t.Errorf("list %s: status %d, want 403", q, rec.Code)
		}
	}

	for _, fields := range []map[string]string{
		{"category": "backup"},
		{"category": "general", "ref_type": "store_backup"},
	} {
		body, ct := multipartBody(t, fields, "x.sql.gz", []byte("data"))
		req := httptest.NewRequest(http.MethodPost, "/api/v1/file/upload", body)
		req.Header.Set("Content-Type", ct)
		req.Header.Set("Authorization", staff)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusForbidden {
			t.Errorf("upload %v: status %d, want 403", fields, rec.Code)
		}
	}

	for name, payload := range map[string]string{
		"presign": `{"filename":"a.gz","category":"backup"}`,
	} {
		req := httptest.NewRequest(http.MethodPost, "/api/v1/file/presign/upload", strings.NewReader(payload))
		req.Header.Set("Authorization", staff)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusForbidden {
			t.Errorf("%s: status %d, want 403", name, rec.Code)
		}
	}

	confirm := `{"filename":"a.gz","r2_key":"backup/2026/11/x.gz","category":"general"}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/file/presign/confirm", strings.NewReader(confirm))
	req.Header.Set("Authorization", staff)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Errorf("confirm backup key: status %d, want 403", rec.Code)
	}
}

func TestUploadBodyIsCapped(t *testing.T) {
	_, router := testHandler()
	body, ct := multipartBody(t, map[string]string{"category": "general"}, "big.bin", bytes.Repeat([]byte("a"), 4096))
	req := httptest.NewRequest(http.MethodPost, "/api/v1/file/upload", body)
	req.Header.Set("Content-Type", ct)
	req.Header.Set("Authorization", "Bearer "+tokenFor(t, "staff"))
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status %d, want 413", rec.Code)
	}
}

func TestSniffContentTypeAvifAndDeclaredFallback(t *testing.T) {
	for _, brand := range []string{"avif", "avis"} {
		data := append([]byte{0, 0, 0, 0x1c}, []byte("ftyp"+brand+"\x00\x00\x00\x00mif1miaf")...)
		got, err := sniffContentType(bytes.NewReader(data), "application/octet-stream")
		if err != nil || got != "image/avif" {
			t.Errorf("brand %s: got %q err %v", brand, got, err)
		}
	}

	// Unknown binary: a declared image/pdf/video type is kept, anything else is not.
	blob := bytes.NewReader([]byte{1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12})
	cases := map[string]string{
		"image/heic":      "image/heic",
		"video/mp4":       "video/mp4",
		"application/pdf": "application/pdf",
		"image/svg+xml":   "application/octet-stream",
		"text/html":       "application/octet-stream",
		"application/zip": "application/octet-stream",
		"":                "application/octet-stream",
	}
	for declared, want := range cases {
		_, _ = blob.Seek(0, 0)
		got, err := sniffContentType(blob, declared)
		if err != nil || got != want {
			t.Errorf("declared %q: got %q, want %q (err %v)", declared, got, want, err)
		}
	}

	// A declared image type must not override content that sniffs as HTML.
	got, _ := sniffContentType(strings.NewReader("<html><script>alert(1)</script></html>"), "image/png")
	if got != "application/octet-stream" {
		t.Errorf("html disguised as png: got %q", got)
	}
}
