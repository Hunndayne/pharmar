package imgstore

import (
	"bytes"
	"image"
	"image/color"
	"image/jpeg"
	"testing"
)

func ip(i int) *int { return &i }

func TestPlanStorageDecisions(t *testing.T) {
	sources := []Source{
		{Kind: "image", Pages: []int{0}},
		{Kind: "pdf", Pages: []int{1, 2}, OriginalIndex: ip(0), HasText: true}, // text + small -> keep PDF
		{Kind: "pdf", Pages: []int{3}, OriginalIndex: ip(1), HasText: true},    // text but heavy -> AVIF
		{Kind: "pdf", Pages: []int{4}, OriginalIndex: ip(2), HasText: false},   // scan -> AVIF
	}
	plan, err := PlanStorage(sources, 5, []int{500_000, 2_000_000, 100}, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	want := []bool{false, true, false, false}
	for i, it := range plan.Items {
		if it.KeepPDF != want[i] {
			t.Errorf("item %d KeepPDF=%v want %v", i, it.KeepPDF, want[i])
		}
	}
	if plan.Items[1].OriginalIndex != 0 {
		t.Error("kept original index")
	}
}

func TestPlanStorageBoundaryAndValidation(t *testing.T) {
	src := []Source{{Kind: "pdf", Pages: []int{0}, OriginalIndex: ip(0), HasText: true}}
	if p, _ := PlanStorage(src, 1, []int{1 << 20}, 1<<20); !p.Items[0].KeepPDF {
		t.Error("size == limit keeps the PDF")
	}
	if p, _ := PlanStorage(src, 1, []int{1<<20 + 1}, 1<<20); p.Items[0].KeepPDF {
		t.Error("size > limit drops the PDF")
	}
	bad := [][]Source{
		{{Kind: "gif", Pages: []int{0}}},
		{{Kind: "image", Pages: []int{5}}},
		{{Kind: "image", Pages: []int{0}}, {Kind: "image", Pages: []int{0}}},
		{{Kind: "pdf", Pages: []int{0}, OriginalIndex: ip(3), HasText: true}},
		{{Kind: "image", Pages: nil}},
	}
	for i, b := range bad {
		if _, err := PlanStorage(b, 1, []int{10}, 1<<20); err == nil {
			t.Errorf("case %d should fail", i)
		}
	}
	if _, err := PlanStorage([]Source{{Kind: "image", Pages: []int{0}}}, 2, nil, 1); err == nil {
		t.Error("unreferenced page should fail")
	}
}

func TestMagicBytes(t *testing.T) {
	if !IsJPEG([]byte{0xFF, 0xD8, 0xFF, 0xE0}) || IsJPEG([]byte("%PDF-1.4")) {
		t.Error("jpeg magic")
	}
	if !IsPDF([]byte("%PDF-1.7")) || IsPDF([]byte{0xFF, 0xD8, 0xFF, 0xE0}) {
		t.Error("pdf magic")
	}
}

func TestEncodeAVIF(t *testing.T) {
	img := image.NewRGBA(image.Rect(0, 0, 64, 48))
	for x := 0; x < 64; x++ {
		for y := 0; y < 48; y++ {
			img.Set(x, y, color.RGBA{uint8(x * 4), uint8(y * 5), 120, 255})
		}
	}
	var jb bytes.Buffer
	if err := jpeg.Encode(&jb, img, &jpeg.Options{Quality: 85}); err != nil {
		t.Fatal(err)
	}
	out, err := EncodeAVIF(jb.Bytes(), 60)
	if err != nil {
		t.Fatal(err)
	}
	if len(out) < 12 || string(out[4:8]) != "ftyp" {
		t.Fatalf("not an AVIF/ISOBMFF file, len=%d", len(out))
	}
	if _, err := EncodeAVIF([]byte("garbage"), 60); err == nil {
		t.Error("garbage must fail")
	}
}
