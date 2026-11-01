package app

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// vnLoc is the pharmacy's day boundary (alpine has no tzdata, so use a fixed offset).
var vnLoc = time.FixedZone("ICT", 7*3600)

func dayStart(now time.Time) time.Time {
	n := now.In(vnLoc)
	return time.Date(n.Year(), n.Month(), n.Day(), 0, 0, 0, 0, vnLoc)
}

func ensureSchema(ctx context.Context, pool *pgxpool.Pool) error {
	stmts := []string{
		`CREATE SCHEMA IF NOT EXISTS ai_service`,
		`CREATE TABLE IF NOT EXISTS ai_service.invoice_name_mappings (
			supplier_id text NOT NULL,
			normalized_name text NOT NULL,
			normalized_unit text NOT NULL,
			raw_name text NOT NULL,
			raw_unit text NOT NULL,
			product_id text NOT NULL,
			unit_id text NULL,
			times_confirmed int NOT NULL DEFAULT 1,
			updated_at timestamptz NOT NULL DEFAULT now(),
			PRIMARY KEY (supplier_id, normalized_name, normalized_unit)
		)`,
		`CREATE TABLE IF NOT EXISTS ai_service.usage_log (
			id bigserial PRIMARY KEY,
			created_at timestamptz NOT NULL DEFAULT now(),
			kind text NOT NULL,
			model text NOT NULL,
			input_tokens int NOT NULL DEFAULT 0,
			cached_input_tokens int NOT NULL DEFAULT 0,
			output_tokens int NOT NULL DEFAULT 0,
			cost_usd numeric(12,6) NOT NULL DEFAULT 0,
			user_id text NOT NULL DEFAULT ''
		)`,
		`CREATE INDEX IF NOT EXISTS idx_ai_usage_log_created_at ON ai_service.usage_log(created_at)`,
	}
	for _, s := range stmts {
		if _, err := pool.Exec(ctx, s); err != nil {
			return fmt.Errorf("ensure schema: %w", err)
		}
	}
	return nil
}

type MappingHit struct {
	ProductID string
	UnitID    string
}

func (s *Service) lookupMapping(ctx context.Context, supplierID, normName, normUnit string) (MappingHit, bool) {
	var hit MappingHit
	var unit *string
	err := s.pool.QueryRow(ctx, `SELECT product_id, unit_id FROM ai_service.invoice_name_mappings
		WHERE supplier_id=$1 AND normalized_name=$2 AND normalized_unit=$3`, supplierID, normName, normUnit).Scan(&hit.ProductID, &unit)
	if err != nil {
		// No row, or a broken memory table: either way the agent handles the line.
		return MappingHit{}, false
	}
	if unit != nil {
		hit.UnitID = *unit
	}
	return hit, true
}

type MappingItem struct {
	RawName   string  `json:"raw_name"`
	RawUnit   string  `json:"raw_unit"`
	ProductID string  `json:"product_id"`
	UnitID    *string `json:"unit_id"`
}

func (s *Service) upsertMappings(ctx context.Context, supplierID string, items []MappingItem, fold func(string) string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	for _, it := range items {
		_, err := tx.Exec(ctx, `INSERT INTO ai_service.invoice_name_mappings
			(supplier_id, normalized_name, normalized_unit, raw_name, raw_unit, product_id, unit_id, times_confirmed, updated_at)
			VALUES ($1,$2,$3,$4,$5,$6,$7,1,now())
			ON CONFLICT (supplier_id, normalized_name, normalized_unit) DO UPDATE SET
				raw_name = EXCLUDED.raw_name, raw_unit = EXCLUDED.raw_unit, product_id = EXCLUDED.product_id,
				unit_id = EXCLUDED.unit_id,
				times_confirmed = ai_service.invoice_name_mappings.times_confirmed + 1, updated_at = now()`,
			supplierID, fold(it.RawName), fold(it.RawUnit), it.RawName, it.RawUnit, it.ProductID, it.UnitID)
		if err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

func (s *Service) logUsage(ctx context.Context, kind, model, userID string, in, cached, out int, cost float64) {
	_, err := s.pool.Exec(ctx, `INSERT INTO ai_service.usage_log (kind, model, input_tokens, cached_input_tokens, output_tokens, cost_usd, user_id)
		VALUES ($1,$2,$3,$4,$5,$6,$7)`, kind, model, in, cached, out, cost, userID)
	if err != nil {
		logf("usage_log insert failed: %v", err)
	}
}

type UsageToday struct {
	Date      string  `json:"date"`
	CostUSD   float64 `json:"cost_usd"`
	BudgetUSD float64 `json:"budget_usd"`
	Requests  int     `json:"requests"`
}

func (s *Service) UsageToday(ctx context.Context) (UsageToday, error) {
	start := dayStart(time.Now())
	var cost float64
	var n int
	err := s.pool.QueryRow(ctx, `SELECT COALESCE(SUM(cost_usd),0)::float8, COUNT(*) FROM ai_service.usage_log WHERE created_at >= $1`, start).Scan(&cost, &n)
	if err != nil {
		return UsageToday{}, err
	}
	return UsageToday{Date: start.Format("2006-01-02"), CostUSD: cost, BudgetUSD: s.cfg.DailyBudgetUSD, Requests: n}, nil
}
