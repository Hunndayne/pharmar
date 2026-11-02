package app

import (
	"strings"
	"testing"

	"file-service/internal/domain"
)

func TestBuildFiltersExcludesBackupsForNonOwners(t *testing.T) {
	s := &Service{}

	where, _ := s.buildFilters("", "", "", "", false)
	if !strings.Contains(where, "backup") || !strings.Contains(where, "store_backup") {
		t.Fatalf("non-owner filter must exclude backups, got %q", where)
	}

	where, _ = s.buildFilters("invoice", "", "", "x", false)
	if !strings.Contains(where, "backup") || !strings.Contains(where, "category = $1") {
		t.Fatalf("exclusion must combine with other filters, got %q", where)
	}

	where, args := s.buildFilters("", "", "", "", true)
	if where != "" || args != nil {
		t.Fatalf("owner without filters should not be restricted, got %q", where)
	}
}

func TestIsBackupRecord(t *testing.T) {
	cases := []struct {
		rec  domain.FileRecord
		want bool
	}{
		{domain.FileRecord{Category: "backup"}, true},
		{domain.FileRecord{Category: "Backup"}, true},
		{domain.FileRecord{Category: "general", RefType: "store_backup"}, true},
		{domain.FileRecord{Category: "general", R2Key: "backup/2026/11/a.gz"}, true},
		{domain.FileRecord{Category: "invoice", R2Key: "invoice/2026/11/a.pdf"}, false},
	}
	for _, c := range cases {
		if got := IsBackupRecord(c.rec); got != c.want {
			t.Errorf("IsBackupRecord(%+v) = %v, want %v", c.rec, got, c.want)
		}
	}
}
