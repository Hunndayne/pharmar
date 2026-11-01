package invoice

import (
	"regexp"
	"sort"
	"strings"

	"ai-service/internal/textutil"
)

type Supplier struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	TaxCode string `json:"tax_code"`
}

type SupplierCandidate struct {
	SupplierID string  `json:"supplier_id"`
	Name       string  `json:"name"`
	TaxCode    string  `json:"tax_code,omitempty"`
	Score      float64 `json:"score"`
}

type SupplierMatch struct {
	Matched    bool                `json:"matched"`
	SupplierID string              `json:"supplier_id,omitempty"`
	Name       string              `json:"name,omitempty"`
	Reason     string              `json:"reason,omitempty"`
	Candidates []SupplierCandidate `json:"candidates"`
}

// MatchSupplier matches by normalised tax code (full code, then the part before the dash); otherwise
// returns up to 3 name-based candidates.
func MatchSupplier(name, taxCode string, suppliers []Supplier) SupplierMatch {
	res := SupplierMatch{Candidates: []SupplierCandidate{}}
	for _, cand := range textutil.TaxCodeCandidates(taxCode) {
		for _, s := range suppliers {
			if textutil.NormalizeTaxCode(s.TaxCode) == cand {
				res.Matched, res.SupplierID, res.Name, res.Reason = true, s.ID, s.Name, "tax_code"
				return res
			}
		}
	}
	want := tokens(name)
	if len(want) == 0 {
		return res
	}
	for _, s := range suppliers {
		got := tokens(s.Name)
		if len(got) == 0 {
			continue
		}
		common := 0
		for t := range want {
			if got[t] {
				common++
			}
		}
		score := float64(common) / float64(minInt(len(want), len(got)))
		if score >= 0.5 {
			res.Candidates = append(res.Candidates, SupplierCandidate{SupplierID: s.ID, Name: s.Name, TaxCode: s.TaxCode, Score: score})
		}
	}
	sort.SliceStable(res.Candidates, func(i, j int) bool { return res.Candidates[i].Score > res.Candidates[j].Score })
	if len(res.Candidates) > 3 {
		res.Candidates = res.Candidates[:3]
	}
	return res
}

// Generic company words, fold-compared; they say nothing about which supplier it is.
var genericPhrases = []string{
	"xuat nhap khau", "thuong mai", "duoc pham", "quoc te", "viet nam", "tap doan", "chi nhanh", "cong ty", "co phan", "dich vu",
	"tnhh", "mtv", "xnk", "cp", "tm", "dv", "duoc",
}

var genericRe = regexp.MustCompile(`\b(` + strings.Join(genericPhrases, "|") + `)\b`)

// DistinctTokens returns the folded tokens of a supplier name without generic company words.
func DistinctTokens(s string) map[string]bool { return tokens(s) }

func tokens(s string) map[string]bool {
	out := map[string]bool{}
	folded := genericRe.ReplaceAllString(textutil.Fold(s), " ")
	for _, t := range strings.FieldsFunc(folded, func(r rune) bool { return !(r >= 'a' && r <= 'z' || r >= '0' && r <= '9') }) {
		if len(t) < 2 {
			continue
		}
		out[t] = true
	}
	return out
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}
