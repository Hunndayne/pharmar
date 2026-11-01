package invoice

import (
	"fmt"
	"math"

	"ai-service/internal/textutil"
)

type Draft struct {
	Quantity    float64 `json:"quantity"`
	ImportPrice float64 `json:"import_price"`
}

type ConvertResult struct {
	Draft   Draft
	Notes   []string
	Warning string // non-empty when the user must handle the line manually
}

// LargestUnit returns the unit with the highest conversion_rate (the import unit).
func LargestUnit(units []ProductUnit) (ProductUnit, bool) {
	var best ProductUnit
	found := false
	for _, u := range units {
		if !found || u.ConversionRate > best.ConversionRate {
			best, found = u, true
		}
	}
	return best, found
}

// ResolveUnit picks the product unit for a line: the agent-chosen id if valid, otherwise a unit whose
// accent-folded name equals the invoice unit.
func ResolveUnit(unitID, rawUnit string, units []ProductUnit) (ProductUnit, bool) {
	if unitID != "" {
		for _, u := range units {
			if u.ID == unitID {
				return u, true
			}
		}
	}
	want := textutil.Fold(rawUnit)
	if want != "" {
		for _, u := range units {
			if textutil.Fold(u.UnitName) == want {
				return u, true
			}
		}
	}
	return ProductUnit{}, false
}

func isWhole(v float64) bool { return math.Abs(v-math.Round(v)) < 1e-6 }

// ImportPrice applies VAT (when the setting says prices include VAT) and rounds to whole dong.
func ImportPrice(unitPrice, vatRate float64, includesVAT bool) float64 {
	if includesVAT {
		unitPrice *= 1 + vatRate
	}
	return math.Round(unitPrice)
}

// Convert turns an invoice line (quantity/price in the invoice unit) into the draft numbers expressed
// in the product's import unit (largest conversion_rate).
func Convert(l Line, invoiceUnit ProductUnit, units []ProductUnit, includesVAT bool) ConvertResult {
	vat := 0.0
	if l.VATRate != nil {
		vat = *l.VATRate
	}
	price := 0.0
	if !l.IsFree && l.UnitPrice != nil {
		price = *l.UnitPrice
	}
	res := ConvertResult{Draft: Draft{Quantity: l.Quantity, ImportPrice: ImportPrice(price, vat, includesVAT)}}
	largest, ok := LargestUnit(units)
	if !ok || invoiceUnit.ConversionRate <= 0 || largest.ConversionRate <= invoiceUnit.ConversionRate {
		return res
	}
	qty := l.Quantity * invoiceUnit.ConversionRate / largest.ConversionRate
	if !isWhole(qty) {
		res.Warning = fmt.Sprintf("Dòng %d: %s %s không quy đổi tròn sang đơn vị nhập %s (1 %s = %s %s), giữ số liệu hóa đơn, hãy tự xử lý",
			l.Index+1, trimFloat(l.Quantity), invoiceUnit.UnitName, largest.UnitName, largest.UnitName, trimFloat(largest.ConversionRate/invoiceUnit.ConversionRate), invoiceUnit.UnitName)
		return res
	}
	factor := largest.ConversionRate / invoiceUnit.ConversionRate
	res.Draft.Quantity = math.Round(qty)
	res.Draft.ImportPrice = ImportPrice(price*factor, vat, includesVAT)
	res.Notes = append(res.Notes, fmt.Sprintf("Quy đổi %s %s = %s %s", trimFloat(l.Quantity), invoiceUnit.UnitName, trimFloat(res.Draft.Quantity), largest.UnitName))
	return res
}

func trimFloat(v float64) string {
	if isWhole(v) {
		return fmt.Sprintf("%.0f", v)
	}
	return fmt.Sprintf("%g", math.Round(v*1000)/1000)
}
