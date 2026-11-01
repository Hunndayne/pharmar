// Package imgstore decides what gets archived (AVIF pages vs original PDF) and encodes AVIF.
package imgstore

import (
	"bytes"
	"fmt"
	"image"
	_ "image/jpeg" // register JPEG decoder
	"sort"

	"github.com/gen2brain/avif"
)

// Source describes where a group of pages came from (one per file the user selected).
type Source struct {
	Kind          string `json:"kind"` // "image" | "pdf"
	Pages         []int  `json:"pages"`
	OriginalIndex *int   `json:"original_index"`
	HasText       bool   `json:"has_text"`
}

// Plan lists what to upload. Entries keep the order the user selected the files in.
type Plan struct {
	Items []PlanItem
}

type PlanItem struct {
	// KeepPDF: upload originals[OriginalIndex] as-is (Pages are not stored as images).
	KeepPDF       bool
	OriginalIndex int
	// Pages: indices into the uploaded pages. For KeepPDF items these are only used for page_count.
	Pages []int
}

// PlanStorage applies the storage rules: image sources -> AVIF pages; text PDFs no larger than
// keepMax bytes -> keep the PDF only; other PDFs (scans or heavy) -> AVIF pages, PDF dropped.
func PlanStorage(sources []Source, pageCount int, originalSizes []int, keepMax int64) (Plan, error) {
	var plan Plan
	used := map[int]bool{}
	keptOriginal := map[int]bool{}
	for si, s := range sources {
		if s.Kind != "image" && s.Kind != "pdf" {
			return plan, fmt.Errorf("sources[%d]: loại nguồn không hợp lệ", si)
		}
		if len(s.Pages) == 0 {
			return plan, fmt.Errorf("sources[%d]: thiếu danh sách trang", si)
		}
		for _, p := range s.Pages {
			if p < 0 || p >= pageCount {
				return plan, fmt.Errorf("sources[%d]: chỉ số trang %d vượt quá số trang đã gửi", si, p)
			}
			if used[p] {
				return plan, fmt.Errorf("sources[%d]: trang %d bị khai báo nhiều lần", si, p)
			}
			used[p] = true
		}
		item := PlanItem{Pages: append([]int(nil), s.Pages...)}
		if s.Kind == "pdf" && s.HasText && s.OriginalIndex != nil {
			oi := *s.OriginalIndex
			if oi < 0 || oi >= len(originalSizes) {
				return plan, fmt.Errorf("sources[%d]: original_index %d không hợp lệ", si, oi)
			}
			if int64(originalSizes[oi]) <= keepMax && !keptOriginal[oi] {
				item.KeepPDF, item.OriginalIndex = true, oi
				keptOriginal[oi] = true
			}
		}
		plan.Items = append(plan.Items, item)
	}
	if len(used) != pageCount {
		var missing []int
		for p := 0; p < pageCount; p++ {
			if !used[p] {
				missing = append(missing, p)
			}
		}
		sort.Ints(missing)
		return plan, fmt.Errorf("trang %v chưa được mô tả trong sources", missing)
	}
	return plan, nil
}

// EncodeAVIF re-encodes a JPEG as AVIF at the same dimensions.
func EncodeAVIF(jpegData []byte, quality int) ([]byte, error) {
	img, _, err := image.Decode(bytes.NewReader(jpegData))
	if err != nil {
		return nil, fmt.Errorf("decode jpeg: %w", err)
	}
	var buf bytes.Buffer
	if err := avif.Encode(&buf, img, avif.Options{Quality: quality, QualityAlpha: quality, Speed: 8, ChromaSubsampling: image.YCbCrSubsampleRatio420}); err != nil {
		return nil, fmt.Errorf("encode avif: %w", err)
	}
	return buf.Bytes(), nil
}

// IsJPEG / IsPDF check magic bytes.
func IsJPEG(b []byte) bool { return len(b) > 3 && b[0] == 0xFF && b[1] == 0xD8 && b[2] == 0xFF }
func IsPDF(b []byte) bool  { return len(b) > 4 && string(b[:4]) == "%PDF" }
