package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"

	"store-service/internal/config"
	"store-service/internal/domain"
)

var (
	ErrNotFound   = errors.New("not found")
	ErrBadRequest = errors.New("bad request")
)

const (
	settingsCacheKeyAllPrefix   = "store:settings:all"
	settingsCacheKeyGroupPrefix = "store:settings:group:"
	settingsCacheKeyItemPrefix  = "store:settings:item:"
)

type Service struct {
	cfg      config.Config
	pool     *pgxpool.Pool
	redis    *redis.Client
	defaults map[string]domain.DefaultSetting
}

func New(ctx context.Context, cfg config.Config) (*Service, error) {
	pool, err := pgxpool.New(ctx, cfg.DatabaseURL)
	if err != nil {
		return nil, fmt.Errorf("connect database: %w", err)
	}

	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping database: %w", err)
	}

	redisClient, err := initRedisClient(ctx, cfg)
	if err != nil {
		pool.Close()
		return nil, err
	}

	svc := &Service{
		cfg:      cfg,
		pool:     pool,
		redis:    redisClient,
		defaults: domain.DefaultSettings(),
	}

	if err := os.MkdirAll(cfg.LogoUploadDir, 0o755); err != nil {
		pool.Close()
		return nil, fmt.Errorf("create logo upload dir: %w", err)
	}

	if err := svc.migrate(ctx); err != nil {
		pool.Close()
		return nil, err
	}

	if err := svc.seedDefaults(ctx); err != nil {
		pool.Close()
		return nil, err
	}

	return svc, nil
}

func (s *Service) Close() {
	if s.redis != nil {
		_ = s.redis.Close()
	}
	s.pool.Close()
}

func initRedisClient(ctx context.Context, cfg config.Config) (*redis.Client, error) {
	redisURL := strings.TrimSpace(cfg.RedisURL)
	if redisURL == "" || cfg.SettingsCacheTTL <= 0 {
		return nil, nil
	}

	options, err := redis.ParseURL(redisURL)
	if err != nil {
		return nil, fmt.Errorf("parse REDIS_URL: %w", err)
	}

	client := redis.NewClient(options)
	if err := client.Ping(ctx).Err(); err != nil {
		log.Printf("redis unavailable, settings cache disabled: %v", err)
		_ = client.Close()
		return nil, nil
	}

	return client, nil
}

func (s *Service) migrate(ctx context.Context) error {
	queries := []string{
		`CREATE EXTENSION IF NOT EXISTS pgcrypto`,
		`CREATE SCHEMA IF NOT EXISTS store`,
		`CREATE TABLE IF NOT EXISTS store.info (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			name VARCHAR(200) NOT NULL,
			address TEXT,
			phone VARCHAR(20),
			email VARCHAR(100),
			tax_code VARCHAR(20),
			license_number VARCHAR(50),
			owner_name VARCHAR(100),
			logo_url TEXT,
			bank_account VARCHAR(50),
			bank_name VARCHAR(100),
			bank_branch VARCHAR(100),
			created_at TIMESTAMPTZ DEFAULT NOW(),
			updated_at TIMESTAMPTZ DEFAULT NOW()
		)`,
		`CREATE TABLE IF NOT EXISTS store.settings (
			"key" VARCHAR(100) PRIMARY KEY,
			value JSONB NOT NULL,
			group_name VARCHAR(50) NOT NULL,
			data_type VARCHAR(20) NOT NULL DEFAULT 'string',
			description TEXT,
			is_public BOOLEAN DEFAULT TRUE,
			updated_at TIMESTAMPTZ DEFAULT NOW(),
			updated_by UUID
		)`,
		`CREATE INDEX IF NOT EXISTS idx_settings_group ON store.settings(group_name)`,
	}

	for _, query := range queries {
		if _, err := s.pool.Exec(ctx, query); err != nil {
			return fmt.Errorf("run migration query: %w", err)
		}
	}

	return nil
}

func (s *Service) seedDefaults(ctx context.Context) error {
	if _, err := s.pool.Exec(
		ctx,
		`INSERT INTO store.info (name) SELECT $1 WHERE NOT EXISTS (SELECT 1 FROM store.info)`,
		s.cfg.DefaultStoreName,
	); err != nil {
		return fmt.Errorf("seed store info: %w", err)
	}

	keys := make([]string, 0, len(s.defaults))
	for key := range s.defaults {
		keys = append(keys, key)
	}
	sort.Strings(keys)

	for _, key := range keys {
		item := s.defaults[key]
		valueJSON, err := json.Marshal(item.Value)
		if err != nil {
			return fmt.Errorf("marshal default setting %s: %w", item.Key, err)
		}

		_, err = s.pool.Exec(
			ctx,
			`INSERT INTO store.settings ("key", value, group_name, data_type, description, is_public)
			 VALUES ($1, $2::jsonb, $3, $4, $5, $6)
			 ON CONFLICT ("key") DO NOTHING`,
			item.Key,
			valueJSON,
			item.GroupName,
			item.DataType,
			item.Description,
			item.IsPublic,
		)
		if err != nil {
			return fmt.Errorf("seed default setting %s: %w", item.Key, err)
		}
	}

	return nil
}

func (s *Service) GetStoreInfo(ctx context.Context) (domain.StoreInfo, error) {
	row := s.pool.QueryRow(
		ctx,
		`SELECT id::text, name, address, phone, email, tax_code, license_number, owner_name,
		        logo_url, bank_account, bank_name, bank_branch, created_at, updated_at
		   FROM store.info
		  ORDER BY created_at
		  LIMIT 1`,
	)
	info, err := scanStoreInfo(row)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return domain.StoreInfo{}, fmt.Errorf("%w: store info not found", ErrNotFound)
		}
		return domain.StoreInfo{}, err
	}
	return info, nil
}

func (s *Service) UpdateStoreInfo(ctx context.Context, payload domain.UpdateStoreInfoRequest) (domain.StoreInfo, error) {
	current, err := s.GetStoreInfo(ctx)
	if err != nil {
		return domain.StoreInfo{}, err
	}

	name := current.Name
	if payload.Name != nil {
		value := strings.TrimSpace(*payload.Name)
		if value == "" {
			return domain.StoreInfo{}, fmt.Errorf("%w: name cannot be empty", ErrBadRequest)
		}
		name = value
	}

	address := mergeOptional(current.Address, payload.Address)
	phone := mergeOptional(current.Phone, payload.Phone)
	email := mergeOptional(current.Email, payload.Email)
	taxCode := mergeOptional(current.TaxCode, payload.TaxCode)
	licenseNumber := mergeOptional(current.LicenseNumber, payload.LicenseNumber)
	ownerName := mergeOptional(current.OwnerName, payload.OwnerName)
	bankAccount := mergeOptional(current.BankAccount, payload.BankAccount)
	bankName := mergeOptional(current.BankName, payload.BankName)
	bankBranch := mergeOptional(current.BankBranch, payload.BankBranch)

	row := s.pool.QueryRow(
		ctx,
		`UPDATE store.info
		    SET name=$2,
		        address=$3,
		        phone=$4,
		        email=$5,
		        tax_code=$6,
		        license_number=$7,
		        owner_name=$8,
		        bank_account=$9,
		        bank_name=$10,
		        bank_branch=$11,
		        updated_at=NOW()
		  WHERE id=$1
		  RETURNING id::text, name, address, phone, email, tax_code, license_number, owner_name,
		            logo_url, bank_account, bank_name, bank_branch, created_at, updated_at`,
		current.ID,
		name,
		address,
		phone,
		email,
		taxCode,
		licenseNumber,
		ownerName,
		bankAccount,
		bankName,
		bankBranch,
	)

	updated, err := scanStoreInfo(row)
	if err != nil {
		return domain.StoreInfo{}, err
	}
	return updated, nil
}

func (s *Service) SaveLogo(ctx context.Context, source io.Reader, originalFilename string) (domain.StoreInfo, error) {
	info, err := s.GetStoreInfo(ctx)
	if err != nil {
		return domain.StoreInfo{}, err
	}

	extension := strings.ToLower(strings.TrimSpace(filepath.Ext(originalFilename)))
	if extension == "" {
		extension = ".bin"
	}
	filename := fmt.Sprintf("%s%s", uuid.NewString(), extension)
	filePath := filepath.Join(s.cfg.LogoUploadDir, filename)

	file, err := os.Create(filePath)
	if err != nil {
		return domain.StoreInfo{}, fmt.Errorf("create logo file: %w", err)
	}

	if _, err := io.Copy(file, source); err != nil {
		_ = file.Close()
		_ = os.Remove(filePath)
		return domain.StoreInfo{}, fmt.Errorf("write logo file: %w", err)
	}
	if err := file.Close(); err != nil {
		_ = os.Remove(filePath)
		return domain.StoreInfo{}, fmt.Errorf("close logo file: %w", err)
	}

	logoURL := fmt.Sprintf("/api/v1/store/uploads/%s", filename)
	updated, err := s.setLogoURL(ctx, &logoURL)
	if err != nil {
		_ = os.Remove(filePath)
		return domain.StoreInfo{}, err
	}

	if info.LogoURL != nil && *info.LogoURL != logoURL {
		s.removeLocalLogo(*info.LogoURL)
	}

	return updated, nil
}

func (s *Service) DeleteLogo(ctx context.Context) (domain.StoreInfo, error) {
	info, err := s.GetStoreInfo(ctx)
	if err != nil {
		return domain.StoreInfo{}, err
	}

	updated, err := s.setLogoURL(ctx, nil)
	if err != nil {
		return domain.StoreInfo{}, err
	}

	if info.LogoURL != nil {
		s.removeLocalLogo(*info.LogoURL)
	}

	return updated, nil
}

func (s *Service) GetAllSettings(ctx context.Context) (map[string]any, error) {
	cached := make(map[string]any)
	if s.getSettingsCache(ctx, settingsCacheKeyAll(), &cached) {
		return cached, nil
	}

	rows, err := s.pool.Query(ctx, `SELECT "key", value FROM store.settings ORDER BY "key"`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	result := make(map[string]any)
	for rows.Next() {
		var key string
		var valueJSON []byte
		if err := rows.Scan(&key, &valueJSON); err != nil {
			return nil, err
		}

		value, err := unmarshalValue(valueJSON)
		if err != nil {
			return nil, err
		}
		result[key] = value
	}

	if err := rows.Err(); err != nil {
		return nil, err
	}

	s.setSettingsCache(ctx, settingsCacheKeyAll(), result)
	return result, nil
}

func (s *Service) GetSettingsByGroup(ctx context.Context, group string) (map[string]any, error) {
	group = strings.TrimSpace(group)
	if group == "" {
		return nil, fmt.Errorf("%w: group is required", ErrBadRequest)
	}

	cacheKey := settingsCacheKeyGroup(group)
	cached := make(map[string]any)
	if s.getSettingsCache(ctx, cacheKey, &cached) {
		return cached, nil
	}

	rows, err := s.pool.Query(
		ctx,
		`SELECT "key", value
		   FROM store.settings
		  WHERE group_name = $1
		  ORDER BY "key"`,
		group,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	result := make(map[string]any)
	for rows.Next() {
		var key string
		var valueJSON []byte
		if err := rows.Scan(&key, &valueJSON); err != nil {
			return nil, err
		}
		value, err := unmarshalValue(valueJSON)
		if err != nil {
			return nil, err
		}
		result[key] = value
	}

	if err := rows.Err(); err != nil {
		return nil, err
	}

	s.setSettingsCache(ctx, cacheKey, result)
	return result, nil
}

func (s *Service) GetSetting(ctx context.Context, key string) (domain.Setting, error) {
	key = strings.TrimSpace(key)
	if key == "" {
		return domain.Setting{}, fmt.Errorf("%w: setting key is required", ErrBadRequest)
	}

	var cached domain.Setting
	if s.getSettingsCache(ctx, settingsCacheKeyItem(key), &cached) {
		return cached, nil
	}

	row := s.pool.QueryRow(
		ctx,
		`SELECT "key", value, group_name, data_type, COALESCE(description, ''), is_public, updated_at, updated_by::text
		   FROM store.settings
		  WHERE "key" = $1`,
		key,
	)

	setting, err := scanSetting(row)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return domain.Setting{}, fmt.Errorf("%w: setting '%s' not found", ErrNotFound, key)
		}
		return domain.Setting{}, err
	}

	s.setSettingsCache(ctx, settingsCacheKeyItem(key), setting)
	return setting, nil
}

func (s *Service) UpdateSetting(ctx context.Context, key string, value any, actor string) (domain.Setting, error) {
	setting, err := s.GetSetting(ctx, key)
	if err != nil {
		return domain.Setting{}, err
	}

	if !validateSettingValue(value, setting.DataType) {
		return domain.Setting{}, fmt.Errorf("%w: value type does not match data_type '%s'", ErrBadRequest, setting.DataType)
	}

	valueJSON, err := json.Marshal(value)
	if err != nil {
		return domain.Setting{}, fmt.Errorf("%w: invalid setting value", ErrBadRequest)
	}

	actorUUID := parseActorUUID(actor)
	row := s.pool.QueryRow(
		ctx,
		`UPDATE store.settings
		    SET value = $2::jsonb,
		        updated_at = NOW(),
		        updated_by = $3
		  WHERE "key" = $1
		  RETURNING "key", value, group_name, data_type, COALESCE(description, ''), is_public, updated_at, updated_by::text`,
		key,
		valueJSON,
		actorUUID,
	)

	updated, err := scanSetting(row)
	if err != nil {
		return domain.Setting{}, err
	}

	s.invalidateSettingsCache(ctx, []string{updated.Key}, []string{updated.GroupName})
	return updated, nil
}

func (s *Service) UpdateSettingsBulk(ctx context.Context, updates map[string]any, actor string) (int, error) {
	if len(updates) == 0 {
		return 0, fmt.Errorf("%w: settings payload is empty", ErrBadRequest)
	}

	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	actorUUID := parseActorUUID(actor)
	updatedCount := 0
	groupsToInvalidate := make(map[string]struct{})

	keys := make([]string, 0, len(updates))
	for key := range updates {
		keys = append(keys, key)
	}
	sort.Strings(keys)

	for _, key := range keys {
		value := updates[key]
		var (
			dataType  string
			groupName string
		)
		err := tx.QueryRow(ctx, `SELECT data_type, group_name FROM store.settings WHERE "key" = $1`, key).Scan(&dataType, &groupName)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return 0, fmt.Errorf("%w: setting '%s' not found", ErrNotFound, key)
			}
			return 0, err
		}

		if !validateSettingValue(value, dataType) {
			return 0, fmt.Errorf("%w: value type does not match data_type '%s' for key '%s'", ErrBadRequest, dataType, key)
		}

		valueJSON, err := json.Marshal(value)
		if err != nil {
			return 0, fmt.Errorf("%w: invalid value for key '%s'", ErrBadRequest, key)
		}

		if _, err := tx.Exec(
			ctx,
			`UPDATE store.settings
			    SET value = $2::jsonb,
			        updated_at = NOW(),
			        updated_by = $3
			  WHERE "key" = $1`,
			key,
			valueJSON,
			actorUUID,
		); err != nil {
			return 0, err
		}
		groupsToInvalidate[groupName] = struct{}{}
		updatedCount++
	}

	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}

	groupNames := make([]string, 0, len(groupsToInvalidate))
	for groupName := range groupsToInvalidate {
		groupNames = append(groupNames, groupName)
	}
	s.invalidateSettingsCache(ctx, keys, groupNames)

	return updatedCount, nil
}

func (s *Service) ResetAllSettings(ctx context.Context, actor string) (int, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	actorUUID := parseActorUUID(actor)
	keys := make([]string, 0, len(s.defaults))
	groupsToInvalidate := make(map[string]struct{})
	for key := range s.defaults {
		keys = append(keys, key)
	}
	sort.Strings(keys)

	updatedCount := 0
	for _, key := range keys {
		item := s.defaults[key]
		valueJSON, err := json.Marshal(item.Value)
		if err != nil {
			return 0, fmt.Errorf("marshal default setting '%s': %w", item.Key, err)
		}

		_, err = tx.Exec(
			ctx,
			`INSERT INTO store.settings ("key", value, group_name, data_type, description, is_public, updated_by, updated_at)
			 VALUES ($1, $2::jsonb, $3, $4, $5, $6, $7, NOW())
			 ON CONFLICT ("key")
			 DO UPDATE
			    SET value = EXCLUDED.value,
			        group_name = EXCLUDED.group_name,
			        data_type = EXCLUDED.data_type,
			        description = EXCLUDED.description,
			        is_public = EXCLUDED.is_public,
			        updated_by = EXCLUDED.updated_by,
			        updated_at = NOW()`,
			item.Key,
			valueJSON,
			item.GroupName,
			item.DataType,
			item.Description,
			item.IsPublic,
			actorUUID,
		)
		if err != nil {
			return 0, err
		}
		groupsToInvalidate[item.GroupName] = struct{}{}
		updatedCount++
	}

	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}

	groupNames := make([]string, 0, len(groupsToInvalidate))
	for groupName := range groupsToInvalidate {
		groupNames = append(groupNames, groupName)
	}
	s.invalidateSettingsCache(ctx, keys, groupNames)

	return updatedCount, nil
}

func (s *Service) ResetSetting(ctx context.Context, key, actor string) (domain.Setting, error) {
	item, ok := s.defaults[key]
	if !ok {
		return domain.Setting{}, fmt.Errorf("%w: default setting for key '%s' not found", ErrNotFound, key)
	}

	valueJSON, err := json.Marshal(item.Value)
	if err != nil {
		return domain.Setting{}, err
	}

	actorUUID := parseActorUUID(actor)
	row := s.pool.QueryRow(
		ctx,
		`INSERT INTO store.settings ("key", value, group_name, data_type, description, is_public, updated_by, updated_at)
		 VALUES ($1, $2::jsonb, $3, $4, $5, $6, $7, NOW())
		 ON CONFLICT ("key")
		 DO UPDATE
		    SET value = EXCLUDED.value,
		        group_name = EXCLUDED.group_name,
		        data_type = EXCLUDED.data_type,
		        description = EXCLUDED.description,
		        is_public = EXCLUDED.is_public,
		        updated_by = EXCLUDED.updated_by,
		        updated_at = NOW()
		 RETURNING "key", value, group_name, data_type, COALESCE(description, ''), is_public, updated_at, updated_by::text`,
		item.Key,
		valueJSON,
		item.GroupName,
		item.DataType,
		item.Description,
		item.IsPublic,
		actorUUID,
	)

	setting, err := scanSetting(row)
	if err != nil {
		return domain.Setting{}, err
	}

	s.invalidateSettingsCache(ctx, []string{setting.Key}, []string{setting.GroupName})
	return setting, nil
}

func (s *Service) setLogoURL(ctx context.Context, logoURL *string) (domain.StoreInfo, error) {
	row := s.pool.QueryRow(
		ctx,
		`UPDATE store.info
		    SET logo_url = $1,
		        updated_at = NOW()
		  WHERE id = (SELECT id FROM store.info ORDER BY created_at LIMIT 1)
		  RETURNING id::text, name, address, phone, email, tax_code, license_number, owner_name,
		            logo_url, bank_account, bank_name, bank_branch, created_at, updated_at`,
		logoURL,
	)
	info, err := scanStoreInfo(row)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return domain.StoreInfo{}, fmt.Errorf("%w: store info not found", ErrNotFound)
		}
		return domain.StoreInfo{}, err
	}
	return info, nil
}

func (s *Service) removeLocalLogo(logoURL string) {
	const prefix = "/api/v1/store/uploads/"
	if !strings.HasPrefix(logoURL, prefix) {
		return
	}

	filename := strings.TrimPrefix(logoURL, prefix)
	if strings.TrimSpace(filename) == "" {
		return
	}

	target := filepath.Join(s.cfg.LogoUploadDir, filepath.Base(filename))
	_ = os.Remove(target)
}

func settingsCacheKeyAll() string {
	return settingsCacheKeyAllPrefix
}

func settingsCacheKeyGroup(group string) string {
	return settingsCacheKeyGroupPrefix + strings.TrimSpace(group)
}

func settingsCacheKeyItem(key string) string {
	return settingsCacheKeyItemPrefix + strings.TrimSpace(key)
}

func (s *Service) getSettingsCache(ctx context.Context, key string, target any) bool {
	if s.redis == nil || s.cfg.SettingsCacheTTL <= 0 {
		return false
	}

	payload, err := s.redis.Get(ctx, key).Bytes()
	if err != nil {
		if errors.Is(err, redis.Nil) {
			return false
		}
		log.Printf("settings cache get failed for key '%s': %v", key, err)
		return false
	}

	if err := json.Unmarshal(payload, target); err != nil {
		log.Printf("settings cache decode failed for key '%s': %v", key, err)
		_ = s.redis.Del(ctx, key).Err()
		return false
	}

	return true
}

func (s *Service) setSettingsCache(ctx context.Context, key string, value any) {
	if s.redis == nil || s.cfg.SettingsCacheTTL <= 0 {
		return
	}

	payload, err := json.Marshal(value)
	if err != nil {
		log.Printf("settings cache encode failed for key '%s': %v", key, err)
		return
	}

	if err := s.redis.Set(ctx, key, payload, s.cfg.SettingsCacheTTL).Err(); err != nil {
		log.Printf("settings cache set failed for key '%s': %v", key, err)
	}
}

func (s *Service) invalidateSettingsCache(ctx context.Context, keys []string, groups []string) {
	if s.redis == nil || s.cfg.SettingsCacheTTL <= 0 {
		return
	}

	cacheKeys := []string{settingsCacheKeyAll()}
	for _, key := range keys {
		trimmed := strings.TrimSpace(key)
		if trimmed != "" {
			cacheKeys = append(cacheKeys, settingsCacheKeyItem(trimmed))
		}
	}

	for _, group := range groups {
		trimmed := strings.TrimSpace(group)
		if trimmed != "" {
			cacheKeys = append(cacheKeys, settingsCacheKeyGroup(trimmed))
		}
	}

	unique := make(map[string]struct{}, len(cacheKeys))
	filtered := make([]string, 0, len(cacheKeys))
	for _, cacheKey := range cacheKeys {
		if _, exists := unique[cacheKey]; exists {
			continue
		}
		unique[cacheKey] = struct{}{}
		filtered = append(filtered, cacheKey)
	}

	if err := s.redis.Del(ctx, filtered...).Err(); err != nil {
		log.Printf("settings cache invalidate failed: %v", err)
	}
}

func mergeOptional(current *string, incoming *string) *string {
	if incoming == nil {
		return current
	}
	value := strings.TrimSpace(*incoming)
	if value == "" {
		return nil
	}
	return &value
}

func parseActorUUID(actor string) *uuid.UUID {
	parsed, err := uuid.Parse(strings.TrimSpace(actor))
	if err != nil {
		return nil
	}
	return &parsed
}

func validateSettingValue(value any, dataType string) bool {
	switch strings.ToLower(strings.TrimSpace(dataType)) {
	case "boolean":
		_, ok := value.(bool)
		return ok
	case "number":
		switch value.(type) {
		case float64, float32, int, int8, int16, int32, int64, uint, uint8, uint16, uint32, uint64:
			return true
		default:
			return false
		}
	case "string":
		_, ok := value.(string)
		return ok
	case "json":
		return true
	default:
		return false
	}
}

func unmarshalValue(raw []byte) (any, error) {
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, err
	}
	return value, nil
}

func scanStoreInfo(row pgx.Row) (domain.StoreInfo, error) {
	var info domain.StoreInfo
	err := row.Scan(
		&info.ID,
		&info.Name,
		&info.Address,
		&info.Phone,
		&info.Email,
		&info.TaxCode,
		&info.LicenseNumber,
		&info.OwnerName,
		&info.LogoURL,
		&info.BankAccount,
		&info.BankName,
		&info.BankBranch,
		&info.CreatedAt,
		&info.UpdatedAt,
	)
	if err != nil {
		return domain.StoreInfo{}, err
	}
	return info, nil
}

func scanSetting(row pgx.Row) (domain.Setting, error) {
	var (
		setting   domain.Setting
		valueJSON []byte
	)

	err := row.Scan(
		&setting.Key,
		&valueJSON,
		&setting.GroupName,
		&setting.DataType,
		&setting.Description,
		&setting.IsPublic,
		&setting.UpdatedAt,
		&setting.UpdatedBy,
	)
	if err != nil {
		return domain.Setting{}, err
	}

	value, err := unmarshalValue(valueJSON)
	if err != nil {
		return domain.Setting{}, err
	}
	setting.Value = value
	return setting, nil
}
