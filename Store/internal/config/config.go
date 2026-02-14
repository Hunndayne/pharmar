package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	AppName          string
	AppPort          int
	DatabaseURL      string
	RedisURL         string
	SettingsCacheTTL time.Duration
	JWTSecretKey     string
	JWTAlgorithm     string
	LogoUploadDir    string
	DefaultStoreName string
}

func Load() (Config, error) {
	appPort, err := getEnvInt("APP_PORT", 8005)
	if err != nil {
		return Config{}, fmt.Errorf("invalid APP_PORT: %w", err)
	}

	settingsCacheTTLSeconds, err := getEnvInt("SETTINGS_CACHE_TTL_SECONDS", 300)
	if err != nil {
		return Config{}, fmt.Errorf("invalid SETTINGS_CACHE_TTL_SECONDS: %w", err)
	}
	if settingsCacheTTLSeconds < 0 {
		return Config{}, fmt.Errorf("SETTINGS_CACHE_TTL_SECONDS must be >= 0")
	}

	cfg := Config{
		AppName:          getEnv("APP_NAME", "Store Service"),
		AppPort:          appPort,
		DatabaseURL:      getEnv("DATABASE_URL", "postgres://postgres:postgres@localhost:5432/pharmar_store?sslmode=disable"),
		RedisURL:         getEnv("REDIS_URL", "redis://localhost:6379/0"),
		SettingsCacheTTL: time.Duration(settingsCacheTTLSeconds) * time.Second,
		JWTSecretKey:     getEnv("JWT_SECRET_KEY", "change-this-secret"),
		JWTAlgorithm:     getEnv("JWT_ALGORITHM", "HS256"),
		LogoUploadDir:    getEnv("LOGO_UPLOAD_DIR", "./uploads"),
		DefaultStoreName: getEnv("DEFAULT_STORE_NAME", "Nha thuoc Pharmar"),
	}

	if strings.TrimSpace(cfg.DatabaseURL) == "" {
		return Config{}, fmt.Errorf("DATABASE_URL is required")
	}

	return cfg, nil
}

func (c Config) Addr() string {
	return fmt.Sprintf(":%d", c.AppPort)
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
