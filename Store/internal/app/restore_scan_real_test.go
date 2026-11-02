package app

import (
	"bytes"
	"compress/gzip"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// scanBackupFileLikeRestore mirrors RestoreBackup: gunzip (if .gz), splitByDatabase, then scan
// every section that would be executed.
func scanBackupFileLikeRestore(t *testing.T, path string) {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()

	var r io.Reader = f
	if strings.HasSuffix(strings.ToLower(path), ".gz") {
		gz, err := gzip.NewReader(f)
		if err != nil {
			t.Fatal(err)
		}
		defer gz.Close()
		r = gz
	}
	data, err := io.ReadAll(r)
	if err != nil {
		t.Fatal(err)
	}

	sections := splitByDatabase(string(data))
	scanned, totalLines := 0, 0
	for _, db := range backupDatabases {
		sql, ok := sections[db]
		if !ok {
			continue
		}
		lines := bytes.Count([]byte(sql), []byte("\n"))
		if err := scanRestoreSQL(sql); err != nil {
			t.Errorf("%s: section %s rejected: %v", path, db, err)
			continue
		}
		scanned++
		totalLines += lines
	}
	t.Logf("%s: %d bytes, %d sections found, %d restorable sections scanned OK, %d lines", path, len(data), len(sections), scanned, totalLines)
	if scanned == 0 {
		t.Errorf("%s: no restorable sections found", path)
	}
}

func TestScanRestoreSQLProductionDump(t *testing.T) {
	path := filepath.Join("..", "..", "..", "recovery", "backup_11_07.sql.gz")
	if _, err := os.Stat(path); err != nil {
		t.Skip("production dump not present")
	}
	scanBackupFileLikeRestore(t, path)
}

// RESTORE_SCAN_FILE=<path to .sql or .sql.gz> go test ./internal/app -run FreshDump -v
func TestScanRestoreSQLFreshDump(t *testing.T) {
	path := os.Getenv("RESTORE_SCAN_FILE")
	if path == "" {
		t.Skip("RESTORE_SCAN_FILE not set")
	}
	scanBackupFileLikeRestore(t, path)
}
