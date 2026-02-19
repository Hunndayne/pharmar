package main

import (
	"bufio"
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
)

type config struct {
	AppName      string
	AppPort      string
	VietQRURL    string
	VietQRClient string
	VietQRKey    string
	JWTSecretKey string
	JWTAlgorithm string
}

type generateQRRequest struct {
	AccountNo   string `json:"accountNo"`
	AccountName string `json:"accountName"`
	AcqID       string `json:"acqId"`
	AddInfo     string `json:"addInfo"`
	Amount      any    `json:"amount"`
}

type generateQRResponse struct {
	Code string          `json:"code"`
	Desc string          `json:"desc"`
	Data vietQRImageData `json:"data"`
}

type vietQRImageData struct {
	QRCode    string `json:"qrCode"`
	QRDataURL string `json:"qrDataURL"`
}

type vietQRGeneratePayload struct {
	AccountNo   string `json:"accountNo"`
	AccountName string `json:"accountName"`
	AcqID       int64  `json:"acqId"`
	AddInfo     string `json:"addInfo"`
	Amount      int64  `json:"amount"`
	Template    string `json:"template"`
}

type vietQRUpstreamResponse struct {
	Code string          `json:"code"`
	Desc string          `json:"desc"`
	Data vietQRImageData `json:"data"`
}

var sanitizeVietQRRegexp = regexp.MustCompile(`[^A-Z0-9 ]+`)

func main() {
	loadDotEnv(".env")
	cfg := loadConfig()
	client := &http.Client{Timeout: 20 * time.Second}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"service": "payment-qr", "status": "ok"})
	})
	mux.HandleFunc("GET /api/v1/payment-qr/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"service": "payment-qr", "status": "ok"})
	})
	mux.HandleFunc("POST /api/v1/payment-qr/generate", withAuth(cfg, func(w http.ResponseWriter, r *http.Request) {
		handleGenerateVietQR(w, r, cfg, client)
	}))

	addr := ":" + cfg.AppPort
	log.Printf("%s listening on %s", cfg.AppName, addr)
	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatal(err)
	}
}

var weakSecrets = map[string]bool{
	"change-this-secret":       true,
	"change-this-internal-key": true,
	"secret":                   true,
	"password":                 true,
	"changeme":                 true,
	"":                         true,
}

func loadConfig() config {
	appEnv := getenv("APP_ENV", "development")
	jwtSecret := getenv("JWT_SECRET_KEY", "change-this-secret")

	if weakSecrets[jwtSecret] || len(jwtSecret) < 16 {
		if appEnv == "production" {
			log.Fatal("JWT_SECRET_KEY is a weak or default value; set a strong secret before running in production")
		}
		log.Printf("WARNING: JWT_SECRET_KEY is using a weak/default value. Change before production deploy.")
	}

	return config{
		AppName:      getenv("APP_NAME", "Payment QR Service"),
		AppPort:      getenv("APP_PORT", "8008"),
		VietQRURL:    getenv("VIETQR_URL", "https://api.vietqr.io/v2/generate"),
		VietQRClient: strings.TrimSpace(os.Getenv("VIETQR_CLIENT_ID")),
		VietQRKey:    strings.TrimSpace(os.Getenv("VIETQR_API_KEY")),
		JWTSecretKey: jwtSecret,
		JWTAlgorithm: getenv("JWT_ALGORITHM", "HS256"),
	}
}

func withAuth(cfg config, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := validateBearerToken(r.Header.Get("Authorization"), cfg); err != nil {
			writeError(w, http.StatusUnauthorized, "Invalid token")
			return
		}
		next(w, r)
	}
}

func validateBearerToken(authHeader string, cfg config) error {
	if strings.TrimSpace(authHeader) == "" {
		return errors.New("missing auth header")
	}
	parts := strings.SplitN(authHeader, " ", 2)
	if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
		return errors.New("invalid bearer format")
	}
	token := strings.TrimSpace(parts[1])
	if token == "" {
		return errors.New("empty token")
	}
	return validateHS256JWT(token, cfg)
}

func validateHS256JWT(token string, cfg config) error {
	if cfg.JWTAlgorithm != "HS256" {
		return errors.New("unsupported jwt algorithm")
	}

	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return errors.New("invalid jwt format")
	}

	headerBytes, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return errors.New("invalid jwt header")
	}
	payloadBytes, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return errors.New("invalid jwt payload")
	}
	signatureBytes, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return errors.New("invalid jwt signature")
	}

	var header map[string]any
	if err := json.Unmarshal(headerBytes, &header); err != nil {
		return errors.New("invalid jwt header json")
	}
	alg, _ := header["alg"].(string)
	if !strings.EqualFold(strings.TrimSpace(alg), cfg.JWTAlgorithm) {
		return errors.New("unexpected jwt alg")
	}

	signingInput := parts[0] + "." + parts[1]
	mac := hmac.New(sha256.New, []byte(cfg.JWTSecretKey))
	_, _ = mac.Write([]byte(signingInput))
	expectedSignature := mac.Sum(nil)
	if !hmac.Equal(signatureBytes, expectedSignature) {
		return errors.New("jwt signature mismatch")
	}

	var claims map[string]any
	if err := json.Unmarshal(payloadBytes, &claims); err != nil {
		return errors.New("invalid jwt claims")
	}

	now := time.Now().Unix()
	if exp, ok := toInt64Claim(claims["exp"]); ok && now >= exp {
		return errors.New("token expired")
	}
	if nbf, ok := toInt64Claim(claims["nbf"]); ok && now < nbf {
		return errors.New("token not active")
	}
	if tokenType, ok := claims["type"].(string); ok {
		tokenType = strings.TrimSpace(strings.ToLower(tokenType))
		if tokenType != "" && tokenType != "access" {
			return errors.New("invalid token type")
		}
	}

	return nil
}

func toInt64Claim(value any) (int64, bool) {
	switch v := value.(type) {
	case float64:
		return int64(v), true
	case float32:
		return int64(v), true
	case int:
		return int64(v), true
	case int64:
		return v, true
	case json.Number:
		parsed, err := v.Int64()
		if err != nil {
			return 0, false
		}
		return parsed, true
	case string:
		parsed, err := strconv.ParseInt(strings.TrimSpace(v), 10, 64)
		if err != nil {
			return 0, false
		}
		return parsed, true
	default:
		return 0, false
	}
}

func handleGenerateVietQR(w http.ResponseWriter, r *http.Request, cfg config, client *http.Client) {
	clientID := strings.TrimSpace(cfg.VietQRClient)
	apiKey := strings.TrimSpace(cfg.VietQRKey)
	if clientID == "" {
		clientID = strings.TrimSpace(os.Getenv("VIETQR_CLIENT_ID"))
	}
	if apiKey == "" {
		apiKey = strings.TrimSpace(os.Getenv("VIETQR_API_KEY"))
	}

	missing := make([]string, 0, 2)
	if clientID == "" {
		missing = append(missing, "VIETQR_CLIENT_ID")
	}
	if apiKey == "" {
		missing = append(missing, "VIETQR_API_KEY")
	}
	if len(missing) > 0 {
		writeError(w, http.StatusServiceUnavailable, fmt.Sprintf("VietQR credentials are not configured (%s)", strings.Join(missing, ", ")))
		return
	}

	var reqBody generateQRRequest
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&reqBody); err != nil {
		writeError(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	accountNo := strings.TrimSpace(reqBody.AccountNo)
	accountName := strings.TrimSpace(reqBody.AccountName)
	acqID := strings.TrimSpace(reqBody.AcqID)
	addInfo := strings.TrimSpace(reqBody.AddInfo)
	amount, err := parsePositiveAmount(reqBody.Amount)
	if err != nil {
		writeError(w, http.StatusBadRequest, "Amount must be a positive integer")
		return
	}
	if accountNo == "" || accountName == "" || acqID == "" {
		writeError(w, http.StatusBadRequest, "accountNo, accountName, acqId are required")
		return
	}
	acqIDNum, err := strconv.ParseInt(acqID, 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "acqId must be numeric")
		return
	}

	upstreamPayload := vietQRGeneratePayload{
		AccountNo:   accountNo,
		AccountName: accountName,
		AcqID:       acqIDNum,
		AddInfo:     addInfo,
		Amount:      amount,
		Template:    "compact",
	}
	upstreamBody, err := json.Marshal(upstreamPayload)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Failed to build VietQR request")
		return
	}

	upstreamReq, err := http.NewRequestWithContext(r.Context(), http.MethodPost, cfg.VietQRURL, bytes.NewReader(upstreamBody))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Failed to build upstream request")
		return
	}
	upstreamReq.Header.Set("Content-Type", "application/json")
	upstreamReq.Header.Set("x-client-id", clientID)
	upstreamReq.Header.Set("x-api-key", apiKey)

	upstreamResp, err := client.Do(upstreamReq)
	if err != nil {
		log.Printf("VietQR upstream request failed: %v", err)
		writeError(w, http.StatusBadGateway, "Payment service temporarily unavailable")
		return
	}
	defer upstreamResp.Body.Close()

	respBytes, err := io.ReadAll(upstreamResp.Body)
	if err != nil {
		writeError(w, http.StatusBadGateway, "Failed to read VietQR response")
		return
	}

	var upstreamJSON vietQRUpstreamResponse
	if err := json.Unmarshal(respBytes, &upstreamJSON); err != nil {
		writeError(w, http.StatusBadGateway, "Invalid response from VietQR")
		return
	}

	if upstreamResp.StatusCode != http.StatusOK {
		detail := strings.TrimSpace(upstreamJSON.Desc)
		if detail == "" {
			detail = "VietQR returned an error"
		}
		writeError(w, http.StatusBadGateway, detail)
		return
	}

	if strings.TrimSpace(upstreamJSON.Code) != "00" {
		detail := strings.TrimSpace(upstreamJSON.Desc)
		if detail == "" {
			detail = "VietQR generation failed"
		}
		writeError(w, http.StatusBadRequest, detail)
		return
	}

	if strings.TrimSpace(upstreamJSON.Data.QRCode) == "" || strings.TrimSpace(upstreamJSON.Data.QRDataURL) == "" {
		writeError(w, http.StatusBadGateway, "VietQR response missing qr data")
		return
	}

	writeJSON(w, http.StatusOK, generateQRResponse{
		Code: upstreamJSON.Code,
		Desc: upstreamJSON.Desc,
		Data: upstreamJSON.Data,
	})
}

func parsePositiveAmount(value any) (int64, error) {
	switch v := value.(type) {
	case float64:
		if v <= 0 || float64(int64(v)) != v {
			return 0, errors.New("invalid amount")
		}
		return int64(v), nil
	case float32:
		if v <= 0 || float32(int64(v)) != v {
			return 0, errors.New("invalid amount")
		}
		return int64(v), nil
	case int:
		if v <= 0 {
			return 0, errors.New("invalid amount")
		}
		return int64(v), nil
	case int64:
		if v <= 0 {
			return 0, errors.New("invalid amount")
		}
		return v, nil
	case string:
		return parsePositiveAmountString(v)
	case json.Number:
		return parsePositiveAmountString(v.String())
	default:
		return 0, errors.New("invalid amount type")
	}
}

func parsePositiveAmountString(raw string) (int64, error) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return 0, errors.New("invalid amount")
	}
	parsed, err := strconv.ParseInt(value, 10, 64)
	if err != nil || parsed <= 0 {
		return 0, errors.New("invalid amount")
	}
	return parsed, nil
}

func writeJSON(w http.ResponseWriter, statusCode int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(statusCode)
	_ = json.NewEncoder(w).Encode(payload)
}

func writeError(w http.ResponseWriter, statusCode int, detail string) {
	writeJSON(w, statusCode, map[string]string{"detail": detail})
}

func getenv(key, fallback string) string {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	return value
}

func loadDotEnv(path string) {
	file, err := os.Open(path)
	if err != nil {
		return
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if strings.HasPrefix(line, "export ") {
			line = strings.TrimSpace(strings.TrimPrefix(line, "export "))
		}
		parts := strings.SplitN(line, "=", 2)
		if len(parts) != 2 {
			continue
		}
		key := strings.TrimSpace(parts[0])
		value := strings.TrimSpace(parts[1])
		value = strings.Trim(value, `"'`)
		if key == "" {
			continue
		}
		if _, exists := os.LookupEnv(key); exists {
			continue
		}
		_ = os.Setenv(key, value)
	}
}
