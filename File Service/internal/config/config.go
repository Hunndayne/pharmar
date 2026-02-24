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
	AppName  string
	AppEnv   string
	AppPort  int
	PublicURL string

	DatabaseURL string

	JWTSecretKey string
	JWTAlgorithm string

	R2AccountID       string
	R2AccessKeyID     string
	R2SecretAccessKey string
	R2BucketName      string
	R2PublicDomain    string

	MaxUploadSize     int64
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

func Load() (Config, error) {
	appPort, err := getEnvInt("APP_PORT", 8009)
	if err != nil {
		return Config{}, fmt.Errorf("invalid APP_PORT: %w", err)
	}

	maxUploadMB, err := getEnvInt("MAX_UPLOAD_SIZE_MB", 50)
	if err != nil {
		return Config{}, fmt.Errorf("invalid MAX_UPLOAD_SIZE_MB: %w", err)
	}

	corsRaw := strings.TrimSpace(getEnv("CORS_ALLOWED_ORIGINS", `["http://localhost:3000","http://localhost:5173"]`))
	var corsOrigins []string
	if strings.HasPrefix(corsRaw, "[") {
		var parsed []string
		if err := json.Unmarshal([]byte(corsRaw), &parsed); err == nil {
			for _, o := range parsed {
				o = strings.TrimSpace(o)
				if o != "" {
					corsOrigins = append(corsOrigins, o)
				}
			}
		}
	} else {
		for _, o := range strings.Split(corsRaw, ",") {
			o = strings.TrimSpace(o)
			if o != "" {
				corsOrigins = append(corsOrigins, o)
			}
		}
	}

	cfg := Config{
		AppName:   getEnv("APP_NAME", "File Service"),
		AppEnv:    getEnv("APP_ENV", "development"),
		AppPort:   appPort,
		PublicURL: getEnv("PUBLIC_URL", ""),

		DatabaseURL: getEnv("DATABASE_URL", "postgres://postgres:postgres@localhost:5432/pharmar_store?sslmode=disable"),

		JWTSecretKey: getEnv("JWT_SECRET_KEY", "change-this-secret"),
		JWTAlgorithm: getEnv("JWT_ALGORITHM", "HS256"),

		R2AccountID:       getEnv("R2_ACCOUNT_ID", ""),
		R2AccessKeyID:     getEnv("R2_ACCESS_KEY_ID", ""),
		R2SecretAccessKey: getEnv("R2_SECRET_ACCESS_KEY", ""),
		R2BucketName:      getEnv("R2_BUCKET_NAME", "pharmar-files"),
		R2PublicDomain:    getEnv("R2_PUBLIC_DOMAIN", ""),

		MaxUploadSize:      int64(maxUploadMB) << 20,
		CORSAllowedOrigins: corsOrigins,
	}

	if strings.TrimSpace(cfg.DatabaseURL) == "" {
		return Config{}, fmt.Errorf("DATABASE_URL is required")
	}

	if strings.TrimSpace(cfg.R2AccountID) == "" || strings.TrimSpace(cfg.R2AccessKeyID) == "" || strings.TrimSpace(cfg.R2SecretAccessKey) == "" {
		if cfg.AppEnv == "production" {
			return Config{}, fmt.Errorf("R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY are required in production")
		}
		log.Printf("WARNING: Cloudflare R2 credentials not set. File uploads will fail.")
	}

	if weakSecrets[cfg.JWTSecretKey] || len(cfg.JWTSecretKey) < 16 {
		if cfg.AppEnv == "production" {
			return Config{}, fmt.Errorf("JWT_SECRET_KEY is a weak or default value; set a strong secret before running in production")
		}
		log.Printf("WARNING: JWT_SECRET_KEY is using a weak/default value. Change before production deploy.")
	}

	return cfg, nil
}

func (c Config) Addr() string {
	return fmt.Sprintf(":%d", c.AppPort)
}

func (c Config) R2Endpoint() string {
	return fmt.Sprintf("https://%s.r2.cloudflarestorage.com", c.R2AccountID)
}

func getEnv(key, fallback string) string {
	if value, ok := os.LookupEnv(key); ok {
		return value
	}
	return fallback
}

func getEnvInt(key string, fallback int) (int, error) {
	raw := getEnv(key, strconv.Itoa(fallback))
	value, err := strconv.Atoi(raw)
	if err != nil {
		return 0, err
	}
	return value, nil
}
