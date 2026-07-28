package app

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"
)

// catalogDrugGroupItem is the subset of the Catalog Service DrugGroupResponse
// schema (Catalog Service/Source/schemas/catalog.py) needed for name matching.
type catalogDrugGroupItem struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// catalogDrugGroupPage mirrors Catalog Service PageResponse[DrugGroupResponse].
type catalogDrugGroupPage struct {
	Items []catalogDrugGroupItem `json:"items"`
	Total int                    `json:"total"`
	Page  int                    `json:"page"`
	Size  int                    `json:"size"`
	Pages int                    `json:"pages"`
}

type pendingCatalogLink struct {
	ID   string
	Name string
}

// runCatalogGroupBackfillJob links store.drug_groups.catalog_group_id to the matching
// Catalog Service drug group (by normalized name) for rows created before the link
// existed. It runs once per service start, in the background, and retries with backoff
// since the Catalog Service may not be up yet when Store starts.
func (s *Service) runCatalogGroupBackfillJob(ctx context.Context) {
	const maxAttempts = 5
	delays := []time.Duration{5 * time.Second, 15 * time.Second, 30 * time.Second, 60 * time.Second}

	for attempt := 1; attempt <= maxAttempts; attempt++ {
		err := s.runCatalogGroupBackfillOnce(ctx)
		if err == nil {
			return
		}

		log.Printf("catalog-group-backfill: attempt %d/%d failed: %v", attempt, maxAttempts, err)

		if attempt == maxAttempts {
			log.Printf("catalog-group-backfill: giving up after %d attempts", maxAttempts)
			return
		}

		delay := delays[len(delays)-1]
		if attempt-1 < len(delays) {
			delay = delays[attempt-1]
		}

		select {
		case <-ctx.Done():
			return
		case <-time.After(delay):
		}
	}
}

func (s *Service) runCatalogGroupBackfillOnce(ctx context.Context) error {
	pending, err := s.fetchPendingCatalogLinks(ctx)
	if err != nil {
		return fmt.Errorf("load store drug groups pending catalog link: %w", err)
	}
	if len(pending) == 0 {
		log.Printf("catalog-group-backfill: no drug groups pending a catalog_group_id link")
		return nil
	}

	token, err := s.createFileServiceToken(ctx)
	if err != nil {
		return fmt.Errorf("mint catalog service token: %w", err)
	}

	catalogGroups, err := s.fetchAllCatalogDrugGroups(ctx, token)
	if err != nil {
		return fmt.Errorf("fetch catalog drug groups: %w", err)
	}

	// Build name -> catalog IDs index. Names that normalize to the same key more than
	// once are ambiguous and must be skipped.
	byName := make(map[string][]string, len(catalogGroups))
	for _, item := range catalogGroups {
		key := normalizeGroupKey(item.Name)
		if key == "" {
			continue
		}
		byName[key] = append(byName[key], item.ID)
	}

	var matched, ambiguous, unmatched int
	for _, group := range pending {
		key := normalizeGroupKey(group.Name)
		candidates := byName[key]

		switch len(candidates) {
		case 0:
			unmatched++
			continue
		case 1:
			if _, err := s.pool.Exec(
				ctx,
				`UPDATE store.drug_groups SET catalog_group_id = $2 WHERE id = $1`,
				group.ID,
				candidates[0],
			); err != nil {
				return fmt.Errorf("update catalog_group_id for group %s: %w", group.ID, err)
			}
			matched++
		default:
			ambiguous++
		}
	}

	log.Printf(
		"catalog-group-backfill: matched=%d ambiguous=%d unmatched=%d (still NULL=%d)",
		matched, ambiguous, unmatched, ambiguous+unmatched,
	)

	return nil
}

func (s *Service) fetchPendingCatalogLinks(ctx context.Context) ([]pendingCatalogLink, error) {
	rows, err := s.pool.Query(
		ctx,
		`SELECT id::text, name FROM store.drug_groups WHERE catalog_group_id IS NULL`,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	items := make([]pendingCatalogLink, 0)
	for rows.Next() {
		var item pendingCatalogLink
		if err := rows.Scan(&item.ID, &item.Name); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	return items, nil
}

func (s *Service) fetchAllCatalogDrugGroups(ctx context.Context, token string) ([]catalogDrugGroupItem, error) {
	baseURL := strings.TrimRight(s.cfg.CatalogServiceURL, "/")
	if baseURL == "" {
		return nil, fmt.Errorf("CATALOG_SERVICE_URL is not configured")
	}

	client := &http.Client{Timeout: 30 * time.Second}
	all := make([]catalogDrugGroupItem, 0)

	page := 1
	for {
		url := fmt.Sprintf("%s/api/v1/catalog/drug-groups?page=%d&size=200", baseURL, page)
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		if err != nil {
			return nil, fmt.Errorf("create request: %w", err)
		}
		req.Header.Set("Authorization", "Bearer "+token)

		resp, err := client.Do(req)
		if err != nil {
			return nil, fmt.Errorf("call catalog drug-groups endpoint: %w", err)
		}

		if resp.StatusCode != http.StatusOK {
			resp.Body.Close()
			return nil, fmt.Errorf("catalog drug-groups endpoint returned %d", resp.StatusCode)
		}

		var pageResp catalogDrugGroupPage
		decodeErr := json.NewDecoder(resp.Body).Decode(&pageResp)
		resp.Body.Close()
		if decodeErr != nil {
			return nil, fmt.Errorf("decode catalog drug-groups response: %w", decodeErr)
		}

		all = append(all, pageResp.Items...)

		if len(pageResp.Items) == 0 || pageResp.Pages <= pageResp.Page {
			break
		}
		page = pageResp.Page + 1
	}

	return all, nil
}

// normalizeGroupKey mirrors the frontend's normalizeGroupKey: only trim + lowercase
// (Vietnamese-locale), no diacritics stripping, so matching stays consistent with the
// FE's temporary name-based join.
func normalizeGroupKey(value string) string {
	return strings.ToLower(strings.TrimSpace(value))
}
