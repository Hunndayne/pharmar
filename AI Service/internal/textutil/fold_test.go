package textutil

import "testing"

func TestFold(t *testing.T) {
	cases := map[string]string{
		"  THUỐC  Ho Bổ PHỔI  ": "thuoc ho bo phoi",
		"Đường Hộp":             "duong hop",
		"Viên nén\tbao phim":    "vien nen bao phim",
		"":                      "",
	}
	for in, want := range cases {
		if got := Fold(in); got != want {
			t.Errorf("Fold(%q)=%q want %q", in, got, want)
		}
	}
}

func TestTaxCodeCandidates(t *testing.T) {
	got := TaxCodeCandidates(" 0105659294 - 002 ")
	if len(got) != 2 || got[0] != "0105659294-002" || got[1] != "0105659294" {
		t.Fatalf("got %v", got)
	}
	if got := TaxCodeCandidates("0101"); len(got) != 1 {
		t.Fatalf("got %v", got)
	}
	if TaxCodeCandidates("  ") != nil {
		t.Fatal("empty should be nil")
	}
}
