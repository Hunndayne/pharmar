package app

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"math"
	"path"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"file-service/internal/config"
	"file-service/internal/domain"
	"file-service/internal/r2"
)

var (
	ErrNotFound   = errors.New("not found")
	ErrBadRequest = errors.New("bad request")
	ErrForbidden  = errors.New("forbidden")
)

type Service struct {
	pool *pgxpool.Pool
	r2   *r2.Client
	cfg  config.Config
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
	log.Printf("Connected to database")

	r2Client, err := r2.New(ctx, cfg)
	if err != nil {
		pool.Close()
		return nil, fmt.Errorf("init r2 client: %w", err)
	}
	log.Printf("Connected to Cloudflare R2 (bucket: %s)", cfg.R2BucketName)

	svc := &Service{
		pool: pool,
		r2:   r2Client,
		cfg:  cfg,
	}

	if err := svc.migrate(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("migrate: %w", err)
	}

	return svc, nil
}

func (s *Service) Close() {
	s.pool.Close()
}

func (s *Service) migrate(ctx context.Context) error {
	queries := []string{
		`CREATE SCHEMA IF NOT EXISTS file_storage`,

		`CREATE TABLE IF NOT EXISTS file_storage.files (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			filename VARCHAR(500) NOT NULL,
			original_name VARCHAR(500) NOT NULL,
			content_type VARCHAR(200) NOT NULL,
			size BIGINT NOT NULL DEFAULT 0,
			r2_key VARCHAR(1000) NOT NULL UNIQUE,
			category VARCHAR(50) NOT NULL DEFAULT 'general',
			ref_type VARCHAR(50),
			ref_id VARCHAR(100),
			uploaded_by VARCHAR(100) NOT NULL,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)`,

		`CREATE INDEX IF NOT EXISTS idx_files_category ON file_storage.files(category)`,
		`CREATE INDEX IF NOT EXISTS idx_files_ref ON file_storage.files(ref_type, ref_id)`,
		`CREATE INDEX IF NOT EXISTS idx_files_uploaded_by ON file_storage.files(uploaded_by)`,
		`CREATE INDEX IF NOT EXISTS idx_files_created_at ON file_storage.files(created_at DESC)`,
		`CREATE INDEX IF NOT EXISTS idx_files_original_name ON file_storage.files USING gin(to_tsvector('simple', original_name))`,
	}

	for _, q := range queries {
		if _, err := s.pool.Exec(ctx, q); err != nil {
			return fmt.Errorf("migrate query: %w", err)
		}
	}

	log.Printf("Database migration completed")
	return nil
}

// Upload stores a file in R2 and records metadata in the database.
func (s *Service) Upload(ctx context.Context, body io.Reader, filename, contentType, category, refType, refID, actor string) (domain.FileRecord, error) {
	category = strings.TrimSpace(strings.ToLower(category))
	if category == "" {
		category = domain.CategoryGeneral
	}
	if !domain.ValidCategories[category] {
		return domain.FileRecord{}, fmt.Errorf("%w: invalid category %q", ErrBadRequest, category)
	}

	fileID := uuid.New().String()
	ext := path.Ext(filename)
	storedName := fileID + ext
	r2Key := fmt.Sprintf("%s/%s/%s", category, time.Now().Format("2006/01"), storedName)

	if err := s.r2.Upload(ctx, r2Key, body, contentType, 0); err != nil {
		return domain.FileRecord{}, fmt.Errorf("upload to r2: %w", err)
	}

	var rec domain.FileRecord
	err := s.pool.QueryRow(ctx, `
		INSERT INTO file_storage.files (id, filename, original_name, content_type, r2_key, category, ref_type, ref_id, uploaded_by)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
		RETURNING id, filename, original_name, content_type, size, r2_key, category, ref_type, ref_id, uploaded_by, created_at
	`, fileID, storedName, filename, contentType, r2Key,
		category, nullIfEmpty(refType), nullIfEmpty(refID), actor,
	).Scan(
		&rec.ID, &rec.Filename, &rec.OrigName, &rec.ContentType,
		&rec.Size, &rec.R2Key, &rec.Category,
		&rec.RefType, &rec.RefID, &rec.UploadedBy, &rec.CreatedAt,
	)
	if err != nil {
		// File uploaded to R2 but DB insert failed — attempt cleanup
		_ = s.r2.Delete(ctx, r2Key)
		return domain.FileRecord{}, fmt.Errorf("insert file record: %w", err)
	}

	rec.URL = s.fileURL(r2Key)
	return rec, nil
}

// UpdateFileSize updates the size field after upload (since we may not know it from a stream).
func (s *Service) UpdateFileSize(ctx context.Context, fileID string, size int64) error {
	_, err := s.pool.Exec(ctx, `UPDATE file_storage.files SET size = $1 WHERE id = $2`, size, fileID)
	return err
}

// GetFile returns a single file record by ID.
func (s *Service) GetFile(ctx context.Context, fileID string) (domain.FileRecord, error) {
	var rec domain.FileRecord
	err := s.pool.QueryRow(ctx, `
		SELECT id, filename, original_name, content_type, size, r2_key, category,
		       COALESCE(ref_type, ''), COALESCE(ref_id, ''), uploaded_by, created_at
		FROM file_storage.files WHERE id = $1
	`, fileID).Scan(
		&rec.ID, &rec.Filename, &rec.OrigName, &rec.ContentType,
		&rec.Size, &rec.R2Key, &rec.Category,
		&rec.RefType, &rec.RefID, &rec.UploadedBy, &rec.CreatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.FileRecord{}, ErrNotFound
	}
	if err != nil {
		return domain.FileRecord{}, fmt.Errorf("get file: %w", err)
	}
	rec.URL = s.fileURL(rec.R2Key)
	return rec, nil
}

// ListFiles returns a paginated, filtered list of files.
func (s *Service) ListFiles(ctx context.Context, category, refType, refID, search string, page, perPage int) (domain.FileListResponse, error) {
	if page < 1 {
		page = 1
	}
	if perPage < 1 || perPage > 100 {
		perPage = 20
	}

	where, args := s.buildFilters(category, refType, refID, search)

	var total int
	countQuery := fmt.Sprintf(`SELECT COUNT(*) FROM file_storage.files %s`, where)
	if err := s.pool.QueryRow(ctx, countQuery, args...).Scan(&total); err != nil {
		return domain.FileListResponse{}, fmt.Errorf("count files: %w", err)
	}

	offset := (page - 1) * perPage
	listQuery := fmt.Sprintf(`
		SELECT id, filename, original_name, content_type, size, r2_key, category,
		       COALESCE(ref_type, ''), COALESCE(ref_id, ''), uploaded_by, created_at
		FROM file_storage.files %s
		ORDER BY created_at DESC
		LIMIT %d OFFSET %d
	`, where, perPage, offset)

	rows, err := s.pool.Query(ctx, listQuery, args...)
	if err != nil {
		return domain.FileListResponse{}, fmt.Errorf("list files: %w", err)
	}
	defer rows.Close()

	var files []domain.FileRecord
	for rows.Next() {
		var rec domain.FileRecord
		if err := rows.Scan(
			&rec.ID, &rec.Filename, &rec.OrigName, &rec.ContentType,
			&rec.Size, &rec.R2Key, &rec.Category,
			&rec.RefType, &rec.RefID, &rec.UploadedBy, &rec.CreatedAt,
		); err != nil {
			return domain.FileListResponse{}, fmt.Errorf("scan file: %w", err)
		}
		rec.URL = s.fileURL(rec.R2Key)
		files = append(files, rec)
	}

	if files == nil {
		files = []domain.FileRecord{}
	}

	totalPages := int(math.Ceil(float64(total) / float64(perPage)))

	return domain.FileListResponse{
		Files:      files,
		Total:      total,
		Page:       page,
		PerPage:    perPage,
		TotalPages: totalPages,
	}, nil
}

// DeleteFile removes a file from R2 and the database.
func (s *Service) DeleteFile(ctx context.Context, fileID string) error {
	var r2Key string
	err := s.pool.QueryRow(ctx, `SELECT r2_key FROM file_storage.files WHERE id = $1`, fileID).Scan(&r2Key)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return fmt.Errorf("get file for delete: %w", err)
	}

	if err := s.r2.Delete(ctx, r2Key); err != nil {
		return fmt.Errorf("delete from r2: %w", err)
	}

	if _, err := s.pool.Exec(ctx, `DELETE FROM file_storage.files WHERE id = $1`, fileID); err != nil {
		return fmt.Errorf("delete file record: %w", err)
	}

	return nil
}

// DeleteByRef removes all files associated with a reference.
func (s *Service) DeleteByRef(ctx context.Context, refType, refID string) (int, error) {
	rows, err := s.pool.Query(ctx, `SELECT r2_key FROM file_storage.files WHERE ref_type = $1 AND ref_id = $2`, refType, refID)
	if err != nil {
		return 0, fmt.Errorf("query files for ref delete: %w", err)
	}
	defer rows.Close()

	var keys []string
	for rows.Next() {
		var key string
		if err := rows.Scan(&key); err != nil {
			return 0, fmt.Errorf("scan r2_key: %w", err)
		}
		keys = append(keys, key)
	}

	if len(keys) == 0 {
		return 0, nil
	}

	if err := s.r2.DeleteMany(ctx, keys); err != nil {
		return 0, fmt.Errorf("delete from r2: %w", err)
	}

	tag, err := s.pool.Exec(ctx, `DELETE FROM file_storage.files WHERE ref_type = $1 AND ref_id = $2`, refType, refID)
	if err != nil {
		return 0, fmt.Errorf("delete file records: %w", err)
	}

	return int(tag.RowsAffected()), nil
}

// GetPresignedDownloadURL returns a presigned URL for direct download from R2.
func (s *Service) GetPresignedDownloadURL(ctx context.Context, fileID string) (domain.PresignedURLResponse, error) {
	rec, err := s.GetFile(ctx, fileID)
	if err != nil {
		return domain.PresignedURLResponse{}, err
	}

	expiry := 1 * time.Hour
	url, err := s.r2.GetPresignedURL(ctx, rec.R2Key, expiry)
	if err != nil {
		return domain.PresignedURLResponse{}, fmt.Errorf("presign download: %w", err)
	}

	return domain.PresignedURLResponse{
		URL:       url,
		ExpiresIn: int(expiry.Seconds()),
	}, nil
}

// GetPresignedUploadURL returns a presigned URL for direct upload to R2.
func (s *Service) GetPresignedUploadURL(ctx context.Context, filename, contentType, category string) (domain.PresignedURLResponse, string, error) {
	category = strings.TrimSpace(strings.ToLower(category))
	if category == "" {
		category = domain.CategoryGeneral
	}
	if !domain.ValidCategories[category] {
		return domain.PresignedURLResponse{}, "", fmt.Errorf("%w: invalid category %q", ErrBadRequest, category)
	}

	fileID := uuid.New().String()
	ext := path.Ext(filename)
	storedName := fileID + ext
	r2Key := fmt.Sprintf("%s/%s/%s", category, time.Now().Format("2006/01"), storedName)

	expiry := 30 * time.Minute
	url, err := s.r2.GetPresignedUploadURL(ctx, r2Key, contentType, expiry)
	if err != nil {
		return domain.PresignedURLResponse{}, "", fmt.Errorf("presign upload: %w", err)
	}

	return domain.PresignedURLResponse{
		URL:       url,
		ExpiresIn: int(expiry.Seconds()),
	}, r2Key, nil
}

// ConfirmUpload records metadata for a file uploaded via presigned URL.
func (s *Service) ConfirmUpload(ctx context.Context, filename, contentType, r2Key, category, refType, refID, actor string, size int64) (domain.FileRecord, error) {
	fileID := uuid.New().String()
	ext := path.Ext(filename)
	storedName := fileID + ext

	var rec domain.FileRecord
	err := s.pool.QueryRow(ctx, `
		INSERT INTO file_storage.files (id, filename, original_name, content_type, size, r2_key, category, ref_type, ref_id, uploaded_by)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
		RETURNING id, filename, original_name, content_type, size, r2_key, category,
		          COALESCE(ref_type, ''), COALESCE(ref_id, ''), uploaded_by, created_at
	`, fileID, storedName, filename, contentType, size, r2Key,
		category, nullIfEmpty(refType), nullIfEmpty(refID), actor,
	).Scan(
		&rec.ID, &rec.Filename, &rec.OrigName, &rec.ContentType,
		&rec.Size, &rec.R2Key, &rec.Category,
		&rec.RefType, &rec.RefID, &rec.UploadedBy, &rec.CreatedAt,
	)
	if err != nil {
		return domain.FileRecord{}, fmt.Errorf("confirm upload record: %w", err)
	}

	rec.URL = s.fileURL(rec.R2Key)
	return rec, nil
}

// ---- helpers ----

func (s *Service) fileURL(r2Key string) string {
	pub := s.r2.PublicURL(r2Key)
	if pub != "" {
		return pub
	}
	if s.cfg.PublicURL != "" {
		return fmt.Sprintf("%s/api/v1/file/download/%s", strings.TrimRight(s.cfg.PublicURL, "/"), r2Key)
	}
	return ""
}

func (s *Service) buildFilters(category, refType, refID, search string) (string, []any) {
	var conditions []string
	var args []any
	idx := 1

	if category != "" {
		conditions = append(conditions, fmt.Sprintf("category = $%d", idx))
		args = append(args, category)
		idx++
	}
	if refType != "" {
		conditions = append(conditions, fmt.Sprintf("ref_type = $%d", idx))
		args = append(args, refType)
		idx++
	}
	if refID != "" {
		conditions = append(conditions, fmt.Sprintf("ref_id = $%d", idx))
		args = append(args, refID)
		idx++
	}
	if search != "" {
		conditions = append(conditions, fmt.Sprintf("to_tsvector('simple', original_name) @@ plainto_tsquery('simple', $%d)", idx))
		args = append(args, search)
		idx++
	}

	if len(conditions) == 0 {
		return "", nil
	}
	return "WHERE " + strings.Join(conditions, " AND "), args
}

func nullIfEmpty(s string) *string {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil
	}
	return &s
}
