// Package invoice contains the pure (no network, no DB) business rules for invoice import.
package invoice

import (
	"encoding/json"
	"math"
	"regexp"
	"strconv"
	"strings"
)

// Num is a lenient JSON number: accepts null, a JSON number, or a string in Vietnamese/plain format.
type Num struct {
	V     float64
	Valid bool
}

var thousandsOnly = regexp.MustCompile(`^\d{1,3}(\.\d{3})+$`)

// ParseNumber parses "57.142,857", "57142.857", "1.234.567", "5%" ...
func ParseNumber(s string) (float64, bool) {
	s = strings.TrimSpace(s)
	s = strings.TrimSuffix(s, "%")
	s = strings.NewReplacer(" ", "", " ", "", "đ", "", "₫", "", "VND", "", "vnd", "").Replace(s)
	if s == "" {
		return 0, false
	}
	hasDot, hasComma := strings.Contains(s, "."), strings.Contains(s, ",")
	switch {
	case hasDot && hasComma:
		if strings.LastIndex(s, ",") > strings.LastIndex(s, ".") {
			s = strings.ReplaceAll(s, ".", "")
			s = strings.Replace(s, ",", ".", 1)
		} else {
			s = strings.ReplaceAll(s, ",", "")
		}
	case hasComma:
		if strings.Count(s, ",") > 1 {
			s = strings.ReplaceAll(s, ",", "")
		} else {
			s = strings.Replace(s, ",", ".", 1)
		}
	case hasDot:
		if thousandsOnly.MatchString(s) {
			s = strings.ReplaceAll(s, ".", "")
		}
	}
	v, err := strconv.ParseFloat(s, 64)
	if err != nil || math.IsNaN(v) || math.IsInf(v, 0) {
		return 0, false
	}
	return v, true
}

func (n *Num) UnmarshalJSON(b []byte) error {
	raw := strings.TrimSpace(string(b))
	if raw == "null" || raw == "" {
		*n = Num{}
		return nil
	}
	if strings.HasPrefix(raw, `"`) {
		var s string
		if err := json.Unmarshal(b, &s); err != nil {
			return err
		}
		v, ok := ParseNumber(s)
		*n = Num{V: v, Valid: ok}
		return nil
	}
	var f float64
	if err := json.Unmarshal(b, &f); err != nil {
		*n = Num{}
		return nil
	}
	*n = Num{V: f, Valid: true}
	return nil
}

// Ptr returns nil when the number is missing.
func (n Num) Ptr() *float64 {
	if !n.Valid {
		return nil
	}
	v := n.V
	return &v
}

// RawLine / RawInvoice mirror the JSON the vision model is asked to produce.
type RawLine struct {
	RawName   string `json:"raw_name"`
	RawUnit   string `json:"raw_unit"`
	Quantity  Num    `json:"quantity"`
	UnitPrice Num    `json:"unit_price"`
	Amount    Num    `json:"amount"`
	VATRate   Num    `json:"vat_rate"`
}

type RawInvoice struct {
	SupplierName    string    `json:"supplier_name"`
	SupplierTaxCode string    `json:"supplier_tax_code"`
	Serial          string    `json:"serial"`
	Number          string    `json:"number"`
	Date            string    `json:"date"`
	LookupCode      string    `json:"lookup_code"`
	Subtotal        Num       `json:"subtotal"`
	VATRate         Num       `json:"vat_rate"`
	VATAmount       Num       `json:"vat_amount"`
	Total           Num       `json:"total"`
	Lines           []RawLine `json:"lines"`
}

// NormalizeRate converts 5 / "5%" into 0.05; values already <= 1 are kept.
func NormalizeRate(n Num) *float64 {
	if !n.Valid || n.V < 0 {
		return nil
	}
	v := n.V
	if v > 1 {
		v = v / 100
	}
	return &v
}

// Header is the cleaned invoice header returned to the client.
type Header struct {
	SupplierName    string   `json:"supplier_name"`
	SupplierTaxCode string   `json:"supplier_tax_code"`
	Serial          string   `json:"serial"`
	Number          string   `json:"number"`
	Date            string   `json:"date"`
	LookupCode      string   `json:"lookup_code"`
	Subtotal        *float64 `json:"subtotal"`
	VATRate         *float64 `json:"vat_rate"`
	VATAmount       *float64 `json:"vat_amount"`
	Total           *float64 `json:"total"`
}

// Line is a cleaned invoice line.
type Line struct {
	Index     int      `json:"index"`
	RawName   string   `json:"raw_name"`
	RawUnit   string   `json:"raw_unit"`
	Quantity  float64  `json:"quantity"`
	UnitPrice *float64 `json:"unit_price"`
	Amount    *float64 `json:"amount"`
	VATRate   *float64 `json:"vat_rate"`
	IsFree    bool     `json:"is_free"`
}

// Product / ProductUnit are the catalog fields we care about (JSON tags match catalog-service).
type ProductUnit struct {
	ID             string  `json:"id"`
	UnitName       string  `json:"unit_name"`
	ConversionRate float64 `json:"conversion_rate"`
	IsBaseUnit     bool    `json:"is_base_unit"`
}

type Product struct {
	ID                 string        `json:"id"`
	Code               string        `json:"code"`
	Name               string        `json:"name"`
	ActiveIngredient   *string       `json:"active_ingredient"`
	RegistrationNumber *string       `json:"registration_number"`
	ManufacturerName   *string       `json:"manufacturer_name"`
	Units              []ProductUnit `json:"units"`
}
