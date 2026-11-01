package invoice

import (
	"fmt"
	"math"
	"strings"
)

// Tolerance is max(1 dong, 0.5%) of the reference value.
func Tolerance(ref float64) float64 {
	return math.Max(1, math.Abs(ref)*0.005)
}

func differs(a, b float64) bool {
	return math.Abs(a-b) > Tolerance(math.Max(math.Abs(a), math.Abs(b)))
}

func fmtVND(v float64) string {
	s := fmt.Sprintf("%.0f", math.Abs(v))
	var out []byte
	for i, c := range []byte(s) {
		if i > 0 && (len(s)-i)%3 == 0 {
			out = append(out, '.')
		}
		out = append(out, c)
	}
	if v < 0 {
		return "-" + string(out)
	}
	return string(out)
}

// BuildHeader converts the raw model output into a cleaned header.
func BuildHeader(r RawInvoice) Header {
	return Header{
		SupplierName:    strings.TrimSpace(r.SupplierName),
		SupplierTaxCode: strings.TrimSpace(r.SupplierTaxCode),
		Serial:          strings.TrimSpace(r.Serial),
		Number:          strings.TrimSpace(r.Number),
		Date:            strings.TrimSpace(r.Date),
		LookupCode:      strings.TrimSpace(r.LookupCode),
		Subtotal:        r.Subtotal.Ptr(),
		VATRate:         NormalizeRate(r.VATRate),
		VATAmount:       r.VATAmount.Ptr(),
		Total:           r.Total.Ptr(),
	}
}

// BuildLines cleans raw lines: fills a missing unit price / amount when derivable and flags free goods
// (no unit price and no amount, or both zero). Line VAT rate falls back to the header rate.
func BuildLines(raw []RawLine, headerVAT *float64) []Line {
	lines := make([]Line, 0, len(raw))
	for i, rl := range raw {
		l := Line{
			Index:     i,
			RawName:   strings.TrimSpace(rl.RawName),
			RawUnit:   strings.TrimSpace(rl.RawUnit),
			Quantity:  rl.Quantity.V,
			UnitPrice: rl.UnitPrice.Ptr(),
			Amount:    rl.Amount.Ptr(),
			VATRate:   NormalizeRate(rl.VATRate),
		}
		if l.VATRate == nil {
			l.VATRate = headerVAT
		}
		price, amount := 0.0, 0.0
		if l.UnitPrice != nil {
			price = *l.UnitPrice
		}
		if l.Amount != nil {
			amount = *l.Amount
		}
		switch {
		case price == 0 && amount == 0:
			l.IsFree = true
			l.UnitPrice, l.Amount = nil, nil
		case price == 0:
			if l.Quantity > 0 {
				v := amount / l.Quantity
				l.UnitPrice = &v
			}
		case amount == 0:
			v := l.Quantity * price
			l.Amount = &v
		}
		lines = append(lines, l)
	}
	return lines
}

// Check runs the arithmetic consistency checks and returns Vietnamese warnings.
func Check(h Header, lines []Line) []string {
	var w []string
	if len(lines) == 0 {
		w = append(w, "Không đọc được dòng hàng nào từ hóa đơn")
	}
	if h.Serial == "" || h.Number == "" {
		w = append(w, "Không đọc được ký hiệu hoặc số hóa đơn, hãy nhập tay")
	}
	sum := 0.0
	for _, l := range lines {
		n := l.Index + 1
		if l.Quantity <= 0 {
			w = append(w, fmt.Sprintf("Dòng %d: không đọc được số lượng", n))
		}
		if l.IsFree {
			w = append(w, fmt.Sprintf("Dòng %d: hàng tặng, chưa có giá", n))
			continue
		}
		if l.UnitPrice != nil && l.Amount != nil && l.Quantity > 0 {
			calc := l.Quantity * *l.UnitPrice
			if differs(calc, *l.Amount) {
				w = append(w, fmt.Sprintf("Dòng %d: số lượng × đơn giá (%s) lệch thành tiền (%s)", n, fmtVND(calc), fmtVND(*l.Amount)))
			}
		}
		if l.Amount != nil {
			sum += *l.Amount
		}
	}
	if h.Subtotal != nil && len(lines) > 0 && differs(sum, *h.Subtotal) {
		w = append(w, fmt.Sprintf("Tổng các dòng (%s) lệch tổng tiền hàng (%s)", fmtVND(sum), fmtVND(*h.Subtotal)))
	}
	if h.Subtotal != nil && h.VATRate != nil && h.VATAmount != nil {
		calc := *h.Subtotal * *h.VATRate
		if differs(calc, *h.VATAmount) {
			w = append(w, fmt.Sprintf("Tiền VAT (%s) lệch tổng tiền hàng × thuế suất (%s)", fmtVND(*h.VATAmount), fmtVND(calc)))
		}
	}
	if h.Subtotal != nil && h.VATAmount != nil && h.Total != nil {
		calc := *h.Subtotal + *h.VATAmount
		if differs(calc, *h.Total) {
			w = append(w, fmt.Sprintf("Tổng thanh toán (%s) lệch tiền hàng + VAT (%s)", fmtVND(*h.Total), fmtVND(calc)))
		}
	}
	return w
}
