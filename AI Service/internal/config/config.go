package config

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"strconv"
	"strings"
)

type Config struct {
	AppName string
	AppEnv  string
	AppPort int

	DatabaseURL string

	JWTSecretKey string
	JWTAlgorithm string

	DeepSeekAPIKey      string
	DeepSeekBaseURL     string
	DeepSeekVisionModel string
	DeepSeekAgentModel  string
	PriceInputMiss      float64 // USD per 1M tokens
	PriceInputHit       float64
	PriceOutput         float64

	DailyBudgetUSD        float64
	KeepPDFMaxBytes       int64
	RequestTimeoutSeconds int

	FileServiceURL      string
	InventoryServiceURL string
	CatalogServiceURL   string
	StoreServiceURL     string

	CORSAllowedOrigins []string
}

var weakSecrets = map[string]bool{
	"change-this-secret":       true,
	"change-this-internal-key": true,
	"secret":                   true,
	"password":                 true,
	"changeme":                 true,
	"":                         true,
}

func (c Config) AIEnabled() bool { return strings.TrimSpace(c.DeepSeekAPIKey) != "" }

func Load() (Config, error) {
	appPort, err := getEnvInt("APP_PORT", 8011)
	if err != nil {
		return Config{}, fmt.Errorf("invalid APP_PORT: %w", err)
	}
	keepMax, err := getEnvInt("AI_KEEP_PDF_MAX_BYTES", 1048576)
	if err != nil {
		return Config{}, fmt.Errorf("invalid AI_KEEP_PDF_MAX_BYTES: %w", err)
	}
	timeout, err := getEnvInt("AI_REQUEST_TIMEOUT_SECONDS", 90)
	if err != nil {
		return Config{}, fmt.Errorf("invalid AI_REQUEST_TIMEOUT_SECONDS: %w", err)
	}
	budget, err := getEnvFloat("AI_DAILY_BUDGET_USD", 1.0)
	if err != nil {
		return Config{}, fmt.Errorf("invalid AI_DAILY_BUDGET_USD: %w", err)
	}
	pMiss, err := getEnvFloat("DEEPSEEK_PRICE_INPUT_MISS", 0.3)
	if err != nil {
		return Config{}, fmt.Errorf("invalid DEEPSEEK_PRICE_INPUT_MISS: %w", err)
	}
	pHit, err := getEnvFloat("DEEPSEEK_PRICE_INPUT_HIT", 0.006)
	if err != nil {
		return Config{}, fmt.Errorf("invalid DEEPSEEK_PRICE_INPUT_HIT: %w", err)
	}
	pOut, err := getEnvFloat("DEEPSEEK_PRICE_OUTPUT", 1.2)
	if err != nil {
		return Config{}, fmt.Errorf("invalid DEEPSEEK_PRICE_OUTPUT: %w", err)
	}

	cfg := Config{
		AppName: getEnv("APP_NAME", "AI Service"),
		AppEnv:  getEnv("APP_ENV", "development"),
		AppPort: appPort,

		DatabaseURL: getEnv("DATABASE_URL", "postgres://postgres:postgres@localhost:5432/pharmar_store?sslmode=disable"),

		JWTSecretKey: getEnv("JWT_SECRET_KEY", "change-this-secret"),
		JWTAlgorithm: getEnv("JWT_ALGORITHM", "HS256"),

		DeepSeekAPIKey:      strings.TrimSpace(getEnv("DEEPSEEK_API_KEY", "")),
		DeepSeekBaseURL:     strings.TrimRight(getEnv("DEEPSEEK_BASE_URL", "https://api.deepseek.com"), "/"),
		DeepSeekVisionModel: getEnv("DEEPSEEK_VISION_MODEL", "deepseek-flash"),
		DeepSeekAgentModel:  getEnv("DEEPSEEK_AGENT_MODEL", "deepseek-flash"),
		PriceInputMiss:      pMiss,
		PriceInputHit:       pHit,
		PriceOutput:         pOut,

		DailyBudgetUSD:        budget,
		KeepPDFMaxBytes:       int64(keepMax),
		RequestTimeoutSeconds: timeout,

		FileServiceURL:      strings.TrimRight(getEnv("FILE_SERVICE_URL", "http://file-service:8009"), "/"),
		InventoryServiceURL: strings.TrimRight(getEnv("INVENTORY_SERVICE_URL", "http://inventory-service:8002"), "/"),
		CatalogServiceURL:   strings.TrimRight(getEnv("CATALOG_SERVICE_URL", "http://catalog-service:8006"), "/"),
		StoreServiceURL:     strings.TrimRight(getEnv("STORE_SERVICE_URL", "http://store-service:8005"), "/"),

		CORSAllowedOrigins: parseOrigins(getEnv("CORS_ALLOWED_ORIGINS", `["http://localhost:3000","http://localhost:5173"]`)),
	}

	if strings.TrimSpace(cfg.DatabaseURL) == "" {
		return Config{}, fmt.Errorf("DATABASE_URL is required")
	}
	if weakSecrets[cfg.JWTSecretKey] || len(cfg.JWTSecretKey) < 16 {
		if cfg.AppEnv == "production" {
			return Config{}, fmt.Errorf("JWT_SECRET_KEY is a weak or default value; set a strong secret before running in production")
		}
		log.Printf("WARNING: JWT_SECRET_KEY is using a weak/default value. Change before production deploy.")
	}
	if !cfg.AIEnabled() {
		log.Printf("WARNING: DEEPSEEK_API_KEY not set. AI extraction runs in disabled mode (503).")
	}
	return cfg, nil
}

func (c Config) Addr() string { return fmt.Sprintf(":%d", c.AppPort) }

func parseOrigins(raw string) []string {
	raw = strings.TrimSpace(raw)
	var out []string
	if strings.HasPrefix(raw, "[") {
		var parsed []string
		if err := json.Unmarshal([]byte(raw), &parsed); err == nil {
			for _, o := range parsed {
				if o = strings.TrimSpace(o); o != "" {
					out = append(out, o)
				}
			}
		}
		return out
	}
	for _, o := range strings.Split(raw, ",") {
		if o = strings.TrimSpace(o); o != "" {
			out = append(out, o)
		}
	}
	return out
}

func getEnv(key, fallback string) string {
	if value, ok := os.LookupEnv(key); ok {
		return value
	}
	return fallback
}

func getEnvInt(key string, fallback int) (int, error) {
	return strconv.Atoi(getEnv(key, strconv.Itoa(fallback)))
}

func getEnvFloat(key string, fallback float64) (float64, error) {
	return strconv.ParseFloat(strings.TrimSpace(getEnv(key, strconv.FormatFloat(fallback, 'f', -1, 64))), 64)
}
