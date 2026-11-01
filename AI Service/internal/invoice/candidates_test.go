package invoice

import (
	"reflect"
	"testing"
)

func prods(names ...string) []Product {
	var out []Product
	for i, n := range names {
		out = append(out, Product{ID: "p" + string(rune('a'+i)), Name: n})
	}
	return out
}

var abiphaBrand = DistinctTokens("CHI NHÁNH CÔNG TY CỔ PHẦN DƯỢC PHẨM QUỐC TẾ ABIPHA")

func TestDeriveQueries(t *testing.T) {
	got := DeriveQueries("TIÊU TRÍ ABIPHA (10 gói x 5g)", abiphaBrand)
	want := []string{"TIÊU TRÍ ABIPHA", "abipha", "tiêu", "trí"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got %q want %q", got, want)
	}
	got = DeriveQueries("THUỐC HO BỔ PHỔI ABIPHA (Hộp 1 lọ x 100ml)", abiphaBrand)
	want = []string{"THUỐC HO BỔ PHỔI ABIPHA", "abipha", "phổi"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got %q want %q", got, want)
	}
	if got := DeriveQueries("Viên", nil); len(got) != 1 {
		t.Errorf("stopword-only name keeps just the full query: %q", got)
	}
	if got := DeriveQueries("  ", nil); got != nil {
		t.Errorf("empty: %q", got)
	}
}

func TestDedupeQueriesAcrossLines(t *testing.T) {
	a := DeriveQueries("TIÊU TRÍ ABIPHA (10 gói x 5g)", abiphaBrand)
	b := DeriveQueries("THUỐC HO BỔ PHỔI ABIPHA (Hộp 1 lọ x 100ml)", abiphaBrand)
	got := DedupeQueries([][]string{a, b})
	n := 0
	for _, q := range got {
		if q == "abipha" {
			n++
		}
	}
	if n != 1 || len(got) != len(a)+len(b)-1 {
		t.Errorf("got %q", got)
	}
}

func TestRankTieuTri(t *testing.T) {
	ps := prods("Calci D3 Abipha", "Siri ho bổ phổi Abipha", "Thuốc tiêu trĩ Abipha")
	c := RankCandidates("TIÊU TRÍ ABIPHA (10 gói x 5g)", abiphaBrand, ps, MaxCandidates)
	if len(c) == 0 || c[0].Product.Name != "Thuốc tiêu trĩ Abipha" {
		t.Fatalf("%+v", c)
	}
	if p, ok := FuzzyPick(c); !ok || p.Product.Name != "Thuốc tiêu trĩ Abipha" {
		t.Errorf("fuzzy pick: %+v %v", p, ok)
	}
}

func TestRankSiriHo(t *testing.T) {
	ps := prods("Thiên môn bổ phổi pre", "Viên ngậm Thiên môn bổ phổi", "Siri ho bổ phổi Abipha")
	c := RankCandidates("THUỐC HO BỔ PHỔI ABIPHA (Hộp 1 lọ x 100ml)", abiphaBrand, ps, MaxCandidates)
	if len(c) < 3 || c[0].Product.Name != "Siri ho bổ phổi Abipha" {
		t.Fatalf("%+v", c)
	}
	if _, ok := FuzzyPick(c); !ok {
		t.Error("should pick")
	}
}

func TestRankCapsAtFive(t *testing.T) {
	ps := prods("a1 abipha", "a2 abipha", "a3 abipha", "a4 abipha", "a5 abipha", "a6 abipha", "a7 abipha")
	if c := RankCandidates("abipha x", abiphaBrand, ps, MaxCandidates); len(c) != 5 {
		t.Errorf("len %d", len(c))
	}
}

func TestFuzzyThresholds(t *testing.T) {
	mk := func(s ...float64) []Candidate {
		var out []Candidate
		for _, v := range s {
			out = append(out, Candidate{Score: v})
		}
		return out
	}
	cases := []struct {
		name string
		c    []Candidate
		ok   bool
	}{
		{"empty", nil, false},
		{"low", mk(0.55, 0.1), false},
		{"exact min alone", mk(0.6), true},
		{"narrow margin", mk(0.9, 0.8), false},
		{"margin ok", mk(0.9, 0.7), true},
		{"tie", mk(1, 1), false},
	}
	for _, tc := range cases {
		if _, ok := FuzzyPick(tc.c); ok != tc.ok {
			t.Errorf("%s: ok=%v", tc.name, ok)
		}
	}
	if c := FuzzyConfidence(1); c > FuzzyMaxConfidence+1e-9 || c < 0.7 {
		t.Errorf("confidence %v", c)
	}
}
