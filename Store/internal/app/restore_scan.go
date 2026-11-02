package app

import (
	"fmt"
	"regexp"
	"strings"
)

// psql executes backslash meta-commands (\! runs a shell command) and the restore runs psql
// as the database superuser, so a restore file must be proven free of them first. The scanner
// below follows psql's own lexer (comments, '...', E'...', "...", $tag$...$tag$, parentheses,
// COPY ... FROM stdin data blocks) so that a backslash hidden in a place psql would still treat
// as a command cannot slip through, and it errs towards rejecting whenever the two could
// disagree. It is defence in depth for an owner-only action, not a SQL sandbox.

var (
	// pg_dump >= 17.6 / 16.10 wraps each dump in \restrict <key> ... \unrestrict <key>.
	allowedMetaLine = regexp.MustCompile(`^\\(restrict|unrestrict) [A-Za-z0-9]+$`)

	programRe         = regexp.MustCompile(`(?i)\b(from|to)\s+program\b`)
	beginAtomicRe     = regexp.MustCompile(`(?i)\bbegin\s+atomic\b`)
	copyFromStdinRe   = regexp.MustCompile(`(?is)^\s*copy\b.*\bfrom\s+stdin\b`)
	setConfigRe       = regexp.MustCompile(`(?i)\bset_config\b`)
	pgDumpSetConfigRe = regexp.MustCompile(`(?i)^\s*select\s+pg_catalog\.set_config\(\s*'search_path'\s*,\s*''\s*,\s*false\s*\)\s*;\s*$`)
	clientEncodingRe  = regexp.MustCompile(`(?i)client_encoding`)
	pgDumpClientEncRe = regexp.MustCompile(`(?i)^\s*set\s+client_encoding\s*=\s*'utf8'\s*;\s*$`)
)

func isIdentCont(c byte) bool {
	return c == '_' || c == '$' || c >= 0x80 || (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
}

func isIdentStart(c byte) bool {
	return c == '_' || c >= 0x80 || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
}

func lineOf(sql string, idx int) int {
	if idx > len(sql) {
		idx = len(sql)
	}
	return strings.Count(sql[:idx], "\n") + 1
}

// checkStatement applies the per-statement rules. raw is the statement text with comments
// removed, code is the same text with string literals and quoted identifiers blanked out.
func checkStatement(raw, code string, line int) error {
	if programRe.MatchString(code) || programRe.MatchString(raw) {
		return fmt.Errorf("restore file contains COPY ... PROGRAM (line %d)", line)
	}
	if beginAtomicRe.MatchString(code) {
		return fmt.Errorf("restore file contains BEGIN ATOMIC function bodies, which cannot be verified safely (line %d)", line)
	}
	// Changing the client encoding or smuggling settings through set_config could make psql
	// lex the file differently from this scanner.
	if clientEncodingRe.MatchString(raw) && !pgDumpClientEncRe.MatchString(raw) {
		return fmt.Errorf("restore file changes client_encoding (line %d)", line)
	}
	if setConfigRe.MatchString(raw) && !pgDumpSetConfigRe.MatchString(raw) {
		return fmt.Errorf("restore file calls set_config (line %d)", line)
	}
	return nil
}

// scanRestoreSQL returns an error if sql contains anything psql would execute besides plain SQL.
func scanRestoreSQL(sql string) error {
	n := len(sql)
	var code, raw strings.Builder
	depth := 0
	prevIdent := false

	put := func(codeText, rawText string) {
		code.WriteString(codeText)
		raw.WriteString(rawText)
	}
	endStatement := func(line int) error {
		err := checkStatement(raw.String(), code.String(), line)
		code.Reset()
		raw.Reset()
		depth = 0
		prevIdent = false
		return err
	}

	stmtStart := 0
	markStart := func(i int) {
		if strings.TrimSpace(raw.String()) == "" {
			stmtStart = i
		}
	}

	for i := 0; i < n; {
		c := sql[i]
		switch {
		case c == '\n':
			put(" ", "\n")
			prevIdent = false
			i++

		case c == '\\':
			if i == 0 || sql[i-1] == '\n' {
				eol := strings.IndexByte(sql[i:], '\n')
				if eol < 0 {
					eol = n - i
				}
				if allowedMetaLine.MatchString(strings.TrimRight(sql[i:i+eol], "\r")) {
					i += eol
					prevIdent = false
					continue
				}
			}
			return fmt.Errorf("restore file contains a psql meta-command (line %d); refusing to run it", lineOf(sql, i))

		case c == '-' && i+1 < n && sql[i+1] == '-':
			eol := strings.IndexByte(sql[i:], '\n')
			if eol < 0 {
				eol = n - i
			}
			put(" ", " ")
			prevIdent = false
			i += eol

		case c == '/' && i+1 < n && sql[i+1] == '*':
			level := 1
			j := i + 2
			for j < n && level > 0 {
				switch {
				case sql[j] == '/' && j+1 < n && sql[j+1] == '*':
					level++
					j += 2
				case sql[j] == '*' && j+1 < n && sql[j+1] == '/':
					level--
					j += 2
				default:
					j++
				}
			}
			if level > 0 {
				return fmt.Errorf("restore file has an unterminated /* comment (line %d)", lineOf(sql, i))
			}
			put(" ", " ")
			prevIdent = false
			i = j

		case c == '\'':
			markStart(i)
			escape := i > 0 && (sql[i-1] == 'e' || sql[i-1] == 'E') && (i < 2 || !isIdentCont(sql[i-2]))
			j := i + 1
			closed := false
			for j < n {
				if escape && sql[j] == '\\' {
					j += 2
					continue
				}
				if sql[j] == '\'' {
					if !escape {
						// With standard_conforming_strings=off a backslash escapes the quote.
						// An odd backslash run before a quote is read differently depending on
						// that setting, so refuse rather than guess.
						k := j - 1
						for k > i && sql[k] == '\\' {
							k--
						}
						if (j-1-k)%2 == 1 {
							return fmt.Errorf("restore file has an ambiguous backslash before a quote (line %d)", lineOf(sql, j))
						}
					}
					if j+1 < n && sql[j+1] == '\'' {
						j += 2
						continue
					}
					closed = true
					j++
					break
				}
				j++
			}
			if !closed {
				return fmt.Errorf("restore file has an unterminated string literal (line %d)", lineOf(sql, i))
			}
			put(" '' ", sql[i:j])
			prevIdent = false
			i = j

		case c == '"':
			markStart(i)
			j := i + 1
			closed := false
			for j < n {
				if sql[j] == '"' {
					if j+1 < n && sql[j+1] == '"' {
						j += 2
						continue
					}
					closed = true
					j++
					break
				}
				j++
			}
			if !closed {
				return fmt.Errorf("restore file has an unterminated quoted identifier (line %d)", lineOf(sql, i))
			}
			put(` "" `, sql[i:j])
			prevIdent = false
			i = j

		case c == '$':
			markStart(i)
			if prevIdent {
				put("$", "$")
				i++
				continue
			}
			j := i + 1
			if j < n && sql[j] >= '0' && sql[j] <= '9' {
				for j < n && sql[j] >= '0' && sql[j] <= '9' {
					j++
				}
				put(sql[i:j], sql[i:j])
				prevIdent = false
				i = j
				continue
			}
			if j < n && isIdentStart(sql[j]) {
				for j < n && isIdentCont(sql[j]) && sql[j] != '$' {
					j++
				}
			}
			if j < n && sql[j] == '$' {
				delim := sql[i : j+1]
				end := strings.Index(sql[j+1:], delim)
				if end < 0 {
					return fmt.Errorf("restore file has an unterminated dollar-quoted string (line %d)", lineOf(sql, i))
				}
				stop := j + 1 + end + len(delim)
				put(" '' ", sql[i:stop])
				prevIdent = false
				i = stop
				continue
			}
			put("$", "$")
			prevIdent = false
			i++

		case c == ';':
			markStart(i)
			put(";", ";")
			i++
			if depth > 0 {
				prevIdent = false
				continue
			}
			isCopyIn := copyFromStdinRe.MatchString(code.String())
			if err := endStatement(lineOf(sql, stmtStart)); err != nil {
				return err
			}
			if !isCopyIn {
				continue
			}
			// COPY ... FROM stdin: the following lines are data until a "\." line, and psql
			// does not interpret backslashes in them as meta-commands.
			eol := strings.IndexByte(sql[i:], '\n')
			if eol < 0 || strings.TrimSpace(sql[i:i+eol]) != "" {
				return fmt.Errorf("restore file has unexpected text after COPY ... FROM stdin (line %d)", lineOf(sql, i))
			}
			i += eol + 1
			terminated := false
			for i < n {
				lineEnd, next := n, n
				if eol := strings.IndexByte(sql[i:], '\n'); eol >= 0 {
					lineEnd = i + eol
					next = lineEnd + 1
				}
				if strings.HasPrefix(sql[i:lineEnd], `\.`) {
					if strings.TrimRight(sql[i:lineEnd], " \t\r") != `\.` {
						return fmt.Errorf("restore file has text after the COPY data terminator (line %d)", lineOf(sql, i))
					}
					terminated = true
					i = next
					break
				}
				i = next
			}
			if !terminated {
				return fmt.Errorf("restore file has an unterminated COPY data block")
			}

		case c == '(':
			markStart(i)
			depth++
			put("(", "(")
			prevIdent = false
			i++

		case c == ')':
			markStart(i)
			if depth > 0 {
				depth--
			}
			put(")", ")")
			prevIdent = false
			i++

		default:
			if c != ' ' && c != '\t' && c != '\r' {
				markStart(i)
			}
			b := string([]byte{c})
			put(b, b)
			prevIdent = isIdentCont(c)
			i++
		}
	}

	if strings.TrimSpace(code.String()) != "" {
		return checkStatement(raw.String(), code.String(), lineOf(sql, stmtStart))
	}
	return nil
}
