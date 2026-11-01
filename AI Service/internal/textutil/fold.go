// Package textutil holds small, dependency-light text helpers shared by the service.
package textutil

import (
	"strings"
	"unicode"

	"golang.org/x/text/unicode/norm"
)

// Fold lowercases, strips Vietnamese diacritics (đ -> d) and collapses whitespace.
func Fold(s string) string {
	s = strings.ToLower(s)
	decomposed := norm.NFD.String(s)
	var b strings.Builder
	b.Grow(len(decomposed))
	for _, r := range decomposed {
		if unicode.Is(unicode.Mn, r) {
			continue
		}
		if r == 'đ' {
			r = 'd'
		}
		b.WriteRune(r)
	}
	return strings.Join(strings.Fields(b.String()), " ")
}

// NormalizeTaxCode removes all whitespace from a tax code.
func NormalizeTaxCode(s string) string {
	return strings.Join(strings.Fields(s), "")
}

// TaxCodeCandidates returns the codes to try when matching: the full code, then the part before the first dash.
func TaxCodeCandidates(s string) []string {
	full := NormalizeTaxCode(s)
	if full == "" {
		return nil
	}
	out := []string{full}
	if i := strings.Index(full, "-"); i > 0 {
		out = append(out, full[:i])
	}
	return out
}
