package app

import (
	"strings"
	"testing"
	"time"
)

func TestClampBackupMaxFilesFloor(t *testing.T) {
	cases := map[int]int{
		-5:                    minBackupMaxFiles,
		0:                     minBackupMaxFiles,
		1:                     minBackupMaxFiles,
		47:                    minBackupMaxFiles,
		48:                    48,
		defaultBackupMaxFiles: defaultBackupMaxFiles,
		500:                   500,
	}
	for in, want := range cases {
		if got := clampBackupMaxFiles(in); got != want {
			t.Errorf("clampBackupMaxFiles(%d) = %d, want %d", in, got, want)
		}
	}
	if defaultBackupMaxFiles != 168 {
		t.Errorf("default max files must stay 168, got %d", defaultBackupMaxFiles)
	}
	if got := clampBackupMaxFiles(parseBackupMaxFiles("2", defaultBackupMaxFiles)); got != minBackupMaxFiles {
		t.Errorf("string setting 2 should clamp to floor, got %d", got)
	}
	if got := parseBackupMaxFiles(float64(100), 5); got != 100 {
		t.Errorf("float64 setting: got %d", got)
	}
	if got := parseBackupMaxFiles("junk", 7); got != 7 {
		t.Errorf("invalid setting should fall back, got %d", got)
	}
}

func TestSelectBackupsToDelete(t *testing.T) {
	now := time.Date(2026, 11, 3, 12, 0, 0, 0, time.UTC)
	mk := func(id string, ago time.Duration) remoteBackupFile {
		return remoteBackupFile{ID: id, CreatedAt: now.Add(-ago)}
	}
	files := []remoteBackupFile{
		mk("h1", 30*time.Minute),
		mk("h2", 90*time.Minute),
		mk("h3", 40*time.Hour),
		mk("d1a", 3*24*time.Hour),                 // newest of its day
		mk("d1b", 3*24*time.Hour+2*time.Hour),     // earlier the same day -> delete
		mk("d2", 10*24*time.Hour),                 // only file of its day -> keep
		mk("m-old-a", 100*24*time.Hour),           // later in its month -> delete
		mk("m-old-b", 100*24*time.Hour+time.Hour), // first of its month -> keep
		mk("ancient", 500*24*time.Hour),           // older than 12 months -> delete
		{ID: "no-date"},                           // unreadable created_at -> never delete
		mk("new", time.Minute),                    // just uploaded -> never delete
	}
	got := map[string]bool{}
	for _, id := range selectBackupsToDelete(files, now, 48, "new") {
		got[id] = true
	}
	for _, id := range []string{"d1b", "ancient", "m-old-a"} {
		if !got[id] {
			t.Errorf("%s should be deleted", id)
		}
	}
	for _, id := range []string{"h1", "h2", "h3", "d1a", "d2", "new", "no-date", "m-old-b"} {
		if got[id] {
			t.Errorf("%s should be kept", id)
		}
	}
}

func TestSelectBackupsToDeleteCapsHourlyTierOnly(t *testing.T) {
	now := time.Date(2026, 11, 20, 12, 0, 0, 0, time.UTC)
	mk := func(id string, ago time.Duration) remoteBackupFile {
		return remoteBackupFile{ID: id, CreatedAt: now.Add(-ago)}
	}
	// Same day, all within 48h: maxHourly=2 keeps the two newest, c is neither newest of the day
	// nor the first of its month (e is), so it is the only one deleted.
	files := []remoteBackupFile{mk("a", time.Hour), mk("b", 2*time.Hour), mk("c", 3*time.Hour), mk("e", 10*24*time.Hour)}
	got := selectBackupsToDelete(files, now, 2, "")
	if len(got) != 1 || got[0] != "c" {
		t.Fatalf("got %v, want [c]", got)
	}
}

func TestScanRestoreSQLAllowsPgDumpOutput(t *testing.T) {
	dump := `--
-- PostgreSQL database dump
--

\restrict AbC123xyz

SET statement_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);

DROP TABLE IF EXISTS public.drugs;
CREATE TABLE public.drugs (
    id integer NOT NULL,
    name text,
    note text DEFAULT 'it''s fine; really'::text,
    CONSTRAINT chk CHECK ((name ~ '^\d+$'::text))
);

CREATE FUNCTION public.f() RETURNS integer
    LANGUAGE plpgsql
    AS $_$
BEGIN
  -- \! looks scary but is inside a dollar-quoted body
  RETURN 1;
END;
$_$;

COMMENT ON TABLE public.drugs IS 'a /* not a comment ; \! nope';

COPY public.drugs (id, name, note) FROM stdin;
1	Paracetamol	\N
2	back\\slash	\\.
\\!not-a-command
\.

SELECT pg_catalog.setval('public.drugs_id_seq', 2, true);

\unrestrict AbC123xyz
`
	if err := scanRestoreSQL(dump); err != nil {
		t.Fatalf("legit pg_dump output rejected: %v", err)
	}
}

func TestScanRestoreSQLRejectsDangerousInput(t *testing.T) {
	cases := map[string]string{
		"shell escape":              "SELECT 1;\n\\! id\n",
		"shell escape mid-line":     "SELECT 1; \\! id\n",
		"indented shell escape":     "  \\! id\n",
		"copy meta":                 "\\copy x from '/etc/passwd'\n",
		"include":                   "\\i /tmp/evil.sql\n",
		"connect mid-section":       "SELECT 1;\n\\connect other\n",
		"restrict with extra":       "\\restrict abc \\! id\n",
		"restrict bad key":          "\\restrict ab-c\n",
		"copy from program":         "COPY t FROM PROGRAM 'id';\n",
		"copy to program lower":     "copy t to program 'id';\n",
		"copy program with comment": "COPY t FROM/**/PROGRAM 'id';\n",
		"program in dollar body":    "DO $$ BEGIN EXECUTE 'COPY t FROM PROGRAM ''id'''; END $$;\n",
		"fake copy hides meta":      "SELECT '\nCOPY a FROM stdin;\n';\n\\! id\n\\.\n",
		"paren hides copy":          "SELECT (1;\nCOPY a FROM stdin;\n\\! id\n\\.\n",
		"meta after copy data":      "COPY a FROM stdin;\n1\n\\.\n\\! id\n",
		"ident hides dollar":        "SELECT abc$x$ \\! id\n$x$;\n",
		"escape string quote":       "SELECT E'\\'' ; \\! id\n",
		"ambiguous backslash":       "SELECT '\\'; \\! id; --';\n",
		"set_config trick":          "SELECT set_config('standard_conforming'||'_strings','off',false);\n",
		"client encoding switch":    "SET client_encoding = 'SJIS';\n",
		"begin atomic":              "CREATE FUNCTION f() RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT 1; END;\n",
		"unterminated string":       "SELECT 'abc;\n",
		"unterminated comment":      "/* abc\n\\! id\n",
		"unterminated dollar":       "SELECT $x$ abc\n",
		"unterminated copy":         "COPY a FROM stdin;\n1\n",
		"text after copy stmt":      "COPY a FROM stdin; SELECT 1;\n1\n\\.\n",
		"text after terminator":     "COPY a FROM stdin;\n1\n\\. \\! id\n",
	}
	for name, sql := range cases {
		if err := scanRestoreSQL(sql); err == nil {
			t.Errorf("%s: expected rejection, got nil for %q", name, sql)
		}
	}
}

func TestScanRestoreSQLMessagesAreClear(t *testing.T) {
	err := scanRestoreSQL("SELECT 1;\n\\! id\n")
	if err == nil || !strings.Contains(err.Error(), "meta-command") || !strings.Contains(err.Error(), "line 2") {
		t.Fatalf("unexpected error: %v", err)
	}
	err = scanRestoreSQL("copy t from program 'x';")
	if err == nil || !strings.Contains(err.Error(), "PROGRAM") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestScanRestoreSQLEdgeCasesFromRealDumps(t *testing.T) {
	cases := map[string]string{
		"empty copy block":  "COPY public.t (a) FROM stdin;\n\\.\n",
		"crlf line endings": "SET x = 1;\r\nCOPY public.t (a) FROM stdin;\r\n1\r\n\\.\r\n\r\nSELECT 1;\r\n",
		"null first column": "COPY public.t (a, b) FROM stdin;\n\\N\tx\n\\.\n",
		"nested comment":    "/* a /* b */ c */ SELECT 1;\n",
		"positional param":  "SELECT $1, $2;\n",
		"no trailing semi":  "SELECT 1",
	}
	for name, sql := range cases {
		if err := scanRestoreSQL(sql); err != nil {
			t.Errorf("%s: unexpected rejection: %v", name, err)
		}
	}
}
