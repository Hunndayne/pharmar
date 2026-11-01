package invoice

import (
	"encoding/json"
	"strings"
	"testing"
)

func f(v float64) *float64 { return &v }

func TestParseNumber(t *testing.T) {
	cases := map[string]float64{
		"57.142,857": 57142.857, "1.234.567": 1234567, "57142.857": 57142.857,
		"1,5": 1.5, "5%": 5, "1,234.5": 1234.5, "12.5": 12.5, "800": 800,
	}
	for in, want := range cases {
		got, ok := ParseNumber(in)
		if !ok || got != want {
			t.Errorf("ParseNumber(%q)=%v,%v want %v", in, got, ok, want)
		}
	}
	if _, ok := ParseNumber("abc"); ok {
		t.Error("abc should fail")
	}
}

func TestRawInvoiceLenientJSON(t *testing.T) {
	var r RawInvoice
	src := `{"subtotal":"768.572","vat_rate":"5%","vat_amount":null,"total":807000,"lines":[{"quantity":"9","unit_price":57142.857}]}`
	if err := json.Unmarshal([]byte(src), &r); err != nil {
		t.Fatal(err)
	}
	if r.Subtotal.V != 768572 {
		t.Fatalf("subtotal %v", r.Subtotal)
	}
	if r.VATAmount.Valid {
		t.Error("null must be invalid")
	}
	if rate := NormalizeRate(r.VATRate); rate == nil || *rate != 0.05 {
		t.Errorf("rate %v", rate)
	}
	if r.Lines[0].Quantity.V != 9 {
		t.Error("string quantity")
	}
}

func TestBuildLinesFreeGoods(t *testing.T) {
	raw := []RawLine{
		{RawName: "A", Quantity: Num{9, true}, UnitPrice: Num{57142.857, true}, Amount: Num{514286, true}},
		{RawName: "B", Quantity: Num{2, true}},
		{RawName: "C", Quantity: Num{2, true}, UnitPrice: Num{0, true}, Amount: Num{0, true}},
		{RawName: "D", Quantity: Num{4, true}, Amount: Num{100, true}},
	}
	lines := BuildLines(raw, f(0.05))
	if lines[0].IsFree || !lines[1].IsFree || !lines[2].IsFree {
		t.Fatalf("free flags wrong: %+v", lines)
	}
	if *lines[0].VATRate != 0.05 {
		t.Error("header VAT fallback")
	}
	if lines[3].UnitPrice == nil || *lines[3].UnitPrice != 25 {
		t.Errorf("derived price %v", lines[3].UnitPrice)
	}
}

func TestCheckWarnings(t *testing.T) {
	h := Header{Serial: "1C25TAB", Number: "1", Subtotal: f(768572), VATRate: f(0.05), VATAmount: f(38428), Total: f(807000)}
	lines := []Line{
		{Index: 0, Quantity: 9, UnitPrice: f(57142.857), Amount: f(514286)},
		{Index: 1, Quantity: 1, UnitPrice: f(254286), Amount: f(254286)},
		{Index: 2, Quantity: 3, IsFree: true},
	}
	if w := Check(h, lines); len(w) != 1 || w[0] != "Dòng 3: hàng tặng, chưa có giá" {
		t.Fatalf("consistent invoice warnings: %v", w)
	}

	bad := Header{Serial: "S", Number: "1", Subtotal: f(900000), VATRate: f(0.05), VATAmount: f(10), Total: f(1)}
	badLines := []Line{{Index: 0, Quantity: 2, UnitPrice: f(100), Amount: f(500)}}
	joined := strings.Join(Check(bad, badLines), "|")
	for _, want := range []string{"Dòng 1: số lượng × đơn giá", "lệch tổng tiền hàng", "Tiền VAT", "Tổng thanh toán"} {
		if !strings.Contains(joined, want) {
			t.Errorf("missing %q in %q", want, joined)
		}
	}
	if w := Check(Header{}, nil); len(w) != 2 {
		t.Errorf("empty invoice warnings: %v", w)
	}
}

func TestToleranceBoundary(t *testing.T) {
	// 0.5% of 1,000,000 = 5,000 dong
	if differs(1000000, 1004999) {
		t.Error("within tolerance")
	}
	if !differs(1000000, 1006000) {
		t.Error("beyond tolerance")
	}
	if differs(100, 100.9) || !differs(100, 101.5) {
		t.Error("1 dong floor")
	}
}

var suppliers = []Supplier{
	{ID: "s1", Name: "Công ty CP Dược phẩm Quốc tế Abipha", TaxCode: "0105659294"},
	{ID: "s2", Name: "Chi nhánh Abipha Hà Nội", TaxCode: "0105659294-002"},
	{ID: "s3", Name: "Công ty TNHH Dược Hậu Giang", TaxCode: "1800156801"},
}

func TestMatchSupplierByTaxCode(t *testing.T) {
	m := MatchSupplier("x", " 0105659294 - 002", suppliers)
	if !m.Matched || m.SupplierID != "s2" || m.Reason != "tax_code" {
		t.Fatalf("exact branch code: %+v", m)
	}
	m = MatchSupplier("x", "0105659294-003", suppliers)
	if !m.Matched || m.SupplierID != "s1" {
		t.Fatalf("fallback to prefix: %+v", m)
	}
}

func TestMatchSupplierCandidates(t *testing.T) {
	m := MatchSupplier("CÔNG TY DƯỢC PHẨM QUỐC TẾ ABIPHA", "", suppliers)
	if m.Matched || len(m.Candidates) == 0 || m.Candidates[0].SupplierID != "s1" {
		t.Fatalf("candidates: %+v", m)
	}
	if len(m.Candidates) > 3 {
		t.Error("max 3 candidates")
	}
	if m := MatchSupplier("Hoàn toàn khác", "9999", suppliers); m.Matched || len(m.Candidates) != 0 {
		t.Errorf("unrelated: %+v", m)
	}
}

var units = []ProductUnit{
	{ID: "u-vien", UnitName: "Viên", ConversionRate: 1, IsBaseUnit: true},
	{ID: "u-vi", UnitName: "Vỉ", ConversionRate: 10},
	{ID: "u-hop", UnitName: "Hộp", ConversionRate: 100},
}

func unit(id string) ProductUnit {
	for _, u := range units {
		if u.ID == id {
			return u
		}
	}
	return ProductUnit{}
}

func TestConvertSameUnitVAT(t *testing.T) {
	l := Line{Index: 0, Quantity: 9, UnitPrice: f(57142.857), VATRate: f(0.05)}
	r := Convert(l, unit("u-hop"), units, true)
	if r.Draft.Quantity != 9 || r.Draft.ImportPrice != 60000 || len(r.Notes) != 0 {
		t.Fatalf("with VAT: %+v", r)
	}
	r = Convert(l, unit("u-hop"), units, false)
	if r.Draft.ImportPrice != 57143 {
		t.Fatalf("without VAT: %+v", r)
	}
}

func TestConvertSmallerUnitInteger(t *testing.T) {
	l := Line{Index: 0, Quantity: 200, UnitPrice: f(1000), VATRate: f(0.1)}
	r := Convert(l, unit("u-vien"), units, true)
	if r.Draft.Quantity != 2 || r.Draft.ImportPrice != 110000 || len(r.Notes) != 1 || r.Warning != "" {
		t.Fatalf("convert: %+v", r)
	}
	r = Convert(Line{Quantity: 30, UnitPrice: f(5000)}, unit("u-vi"), units, true)
	if r.Draft.Quantity != 3 || r.Draft.ImportPrice != 50000 {
		t.Fatalf("vi->hop: %+v", r)
	}
}

func TestConvertNonInteger(t *testing.T) {
	l := Line{Index: 4, Quantity: 150, UnitPrice: f(1000), VATRate: f(0)}
	r := Convert(l, unit("u-vien"), units, true)
	if r.Draft.Quantity != 150 || r.Draft.ImportPrice != 1000 || !strings.HasPrefix(r.Warning, "Dòng 5") {
		t.Fatalf("non-integer: %+v", r)
	}
}

func TestConvertFreeGoods(t *testing.T) {
	r := Convert(Line{Quantity: 3, IsFree: true, VATRate: f(0.05)}, unit("u-hop"), units, true)
	if r.Draft.ImportPrice != 0 || r.Draft.Quantity != 3 {
		t.Fatalf("free: %+v", r)
	}
}

func TestResolveUnit(t *testing.T) {
	if u, ok := ResolveUnit("u-vi", "Hộp", units); !ok || u.ID != "u-vi" {
		t.Error("explicit id wins")
	}
	if u, ok := ResolveUnit("bogus", "HỘP", units); !ok || u.ID != "u-hop" {
		t.Error("fallback by folded name")
	}
	if _, ok := ResolveUnit("", "Chai", units); ok {
		t.Error("unknown unit")
	}
}

func TestSupplierGenericWordsIgnored(t *testing.T) {
	name := "CHI NHÁNH CÔNG TY CỔ PHẦN DƯỢC PHẨM QUỐC TẾ ABIPHA"
	noise := []Supplier{{ID: "n1", Name: "Dược vương"}, {ID: "n2", Name: "Nam dược"}}
	if m := MatchSupplier(name, "", noise); len(m.Candidates) != 0 {
		t.Errorf("noise candidates: %+v", m.Candidates)
	}
	good := []Supplier{{ID: "g1", Name: "ABIPHA"}, {ID: "g2", Name: "Dược phẩm Abipha"}, {ID: "n1", Name: "Dược vương"}}
	m := MatchSupplier(name, "", good)
	if len(m.Candidates) != 2 {
		t.Fatalf("candidates: %+v", m.Candidates)
	}
	// Name made only of generic words yields nothing.
	if m := MatchSupplier("Công ty TNHH Dược phẩm", "", good); len(m.Candidates) != 0 {
		t.Errorf("generic-only: %+v", m.Candidates)
	}
}
