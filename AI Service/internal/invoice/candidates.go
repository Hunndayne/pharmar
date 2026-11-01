package invoice

import (
	"regexp"
	"sort"
	"strings"
	"unicode"

	"ai-service/internal/textutil"
)

const (
	MaxQueriesPerLine = 4
	MaxCandidates     = 5
	// FuzzyMinScore / FuzzyMargin gate the deterministic fallback: the top candidate must be good
	// in absolute terms and clearly ahead of the runner-up.
	FuzzyMinScore = 0.6
	FuzzyMargin   = 0.15
	// FuzzyMaxConfidence keeps fuzzy matches below the UI's "confident" level so they get reviewed.
	FuzzyMaxConfidence = 0.8
	brandBonus         = 0.1
)

// Candidate is a catalog product retrieved deterministically for an invoice line.
type Candidate struct {
	Product Product
	Score   float64
}

var parenRe = regexp.MustCompile(`\([^)]*\)?`)

// Single folded words that carry no product identity (dosage form, packaging, units, filler).
var nameStopwords = map[string]bool{
	"thuoc": true, "vien": true, "hop": true, "lo": true, "chai": true, "goi": true, "ong": true, "vi": true,
	"siro": true, "dung": true, "dich": true, "kem": true, "gel": true, "mg": true, "ml": true, "g": true,
	"x": true, "va": true,
}

// CleanName removes parenthetical packaging text, e.g. "(10 goi x 5g)".
func CleanName(raw string) string {
	return strings.Join(strings.Fields(parenRe.ReplaceAllString(raw, " ")), " ")
}

func splitWords(s string) []string {
	return strings.FieldsFunc(s, func(r rune) bool { return !unicode.IsLetter(r) && !unicode.IsDigit(r) })
}

func letterCount(s string) int { return len([]rune(s)) }

// SignificantTokens returns the folded, stopword-free tokens of a name (packaging removed), as an ordered set.
func SignificantTokens(name string) []string {
	var out []string
	seen := map[string]bool{}
	for _, w := range splitWords(CleanName(name)) {
		f := textutil.Fold(w)
		if f == "" || nameStopwords[f] || seen[f] || letterCount(f) < 2 {
			continue
		}
		seen[f] = true
		out = append(out, f)
	}
	return out
}

// DeriveQueries builds up to MaxQueriesPerLine catalog search queries for one invoice line:
// the full cleaned name, then brand words (shared with the supplier name), then the remaining
// significant words, longest first.
func DeriveQueries(rawName string, brand map[string]bool) []string {
	cleaned := CleanName(rawName)
	if cleaned == "" {
		return nil
	}
	var queries []string
	seen := map[string]bool{}
	add := func(q string) {
		k := textutil.Fold(q)
		if k == "" || seen[k] || len(queries) >= MaxQueriesPerLine {
			return
		}
		seen[k] = true
		queries = append(queries, q)
	}
	add(cleaned)

	type word struct{ text, folded string }
	var brandWords, others []word
	used := map[string]bool{}
	for _, w := range splitWords(cleaned) {
		f := textutil.Fold(w)
		if nameStopwords[f] || letterCount(f) < 3 || used[f] {
			continue
		}
		used[f] = true
		if brand[f] {
			brandWords = append(brandWords, word{strings.ToLower(w), f})
		} else {
			others = append(others, word{strings.ToLower(w), f})
		}
	}
	sort.SliceStable(others, func(i, j int) bool { return letterCount(others[i].folded) > letterCount(others[j].folded) })
	for _, w := range brandWords {
		add(w.text)
	}
	for _, w := range others {
		add(w.text)
	}
	return queries
}

// DedupeQueries returns each distinct (folded) query once, in first-seen order.
func DedupeQueries(perLine [][]string) []string {
	var out []string
	seen := map[string]bool{}
	for _, qs := range perLine {
		for _, q := range qs {
			k := textutil.Fold(q)
			if seen[k] {
				continue
			}
			seen[k] = true
			out = append(out, q)
		}
	}
	return out
}

// ScoreName is the Dice coefficient between the folded significant tokens of an invoice name and a
// product name, plus a bonus when a brand token appears in both. Result is in [0,1].
func ScoreName(lineName, productName string, brand map[string]bool) float64 {
	a, b := SignificantTokens(lineName), SignificantTokens(productName)
	if len(a) == 0 || len(b) == 0 {
		return 0
	}
	inB := map[string]bool{}
	for _, t := range b {
		inB[t] = true
	}
	common, hasBrand := 0, false
	for _, t := range a {
		if inB[t] {
			common++
			if brand[t] {
				hasBrand = true
			}
		}
	}
	if common == 0 {
		return 0
	}
	score := 2 * float64(common) / float64(len(a)+len(b))
	if hasBrand {
		score += brandBonus
	}
	if score > 1 {
		score = 1
	}
	return score
}

// RankCandidates scores every product against the line and keeps the best n with score > 0.
func RankCandidates(lineName string, brand map[string]bool, products []Product, n int) []Candidate {
	var out []Candidate
	for _, p := range products {
		if s := ScoreName(lineName, p.Name, brand); s > 0 {
			out = append(out, Candidate{Product: p, Score: s})
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Score > out[j].Score })
	if len(out) > n {
		out = out[:n]
	}
	return out
}

// FuzzyPick returns the top candidate when it is good enough and clearly ahead of the runner-up.
func FuzzyPick(cands []Candidate) (Candidate, bool) {
	if len(cands) == 0 || cands[0].Score < FuzzyMinScore {
		return Candidate{}, false
	}
	if len(cands) > 1 && cands[0].Score-cands[1].Score < FuzzyMargin {
		return Candidate{}, false
	}
	return cands[0], true
}

// FuzzyConfidence maps a score in [FuzzyMinScore,1] to a conservative confidence in [0.68,FuzzyMaxConfidence].
func FuzzyConfidence(score float64) float64 {
	c := 0.5 + 0.3*score
	if c > FuzzyMaxConfidence {
		c = FuzzyMaxConfidence
	}
	return c
}
