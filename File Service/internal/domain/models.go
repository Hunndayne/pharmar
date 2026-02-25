package domain

import "time"

// FileRecord represents a file stored in R2.
type FileRecord struct {
	ID          string    `json:"id"`
	Filename    string    `json:"filename"`
	OrigName    string    `json:"original_name"`
	ContentType string    `json:"content_type"`
	Size        int64     `json:"size"`
	R2Key       string    `json:"r2_key"`
	URL         string    `json:"url"`
	Category    string    `json:"category"`
	RefType     string    `json:"ref_type,omitempty"`
	RefID       string    `json:"ref_id,omitempty"`
	UploadedBy  string    `json:"uploaded_by"`
	CreatedAt   time.Time `json:"created_at"`
}

// Folder is a logical grouping path for files.
type Folder struct {
	ID        string    `json:"id"`
	Path      string    `json:"path"`
	Name      string    `json:"name"`
	CreatedAt time.Time `json:"created_at"`
}

// PresignedURLResponse is returned when generating a presigned URL.
type PresignedURLResponse struct {
	URL       string `json:"url"`
	ExpiresIn int    `json:"expires_in"`
}

// FileListResponse wraps a paginated list of files.
type FileListResponse struct {
	Files      []FileRecord `json:"files"`
	Total      int          `json:"total"`
	Page       int          `json:"page"`
	PerPage    int          `json:"per_page"`
	TotalPages int          `json:"total_pages"`
}

// Categories for file organization.
const (
	CategoryProduct   = "product"
	CategoryInvoice   = "invoice"
	CategoryDocument  = "document"
	CategoryAvatar    = "avatar"
	CategoryLogo      = "logo"
	CategoryBackup    = "backup"
	CategoryGeneral   = "general"
)

// ValidCategories is the set of allowed categories.
var ValidCategories = map[string]bool{
	CategoryProduct:  true,
	CategoryInvoice:  true,
	CategoryDocument: true,
	CategoryAvatar:   true,
	CategoryLogo:     true,
	CategoryBackup:   true,
	CategoryGeneral:  true,
}
