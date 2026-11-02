package app

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"time"
)

const (
	// backupFailNotifyThreshold is the number of consecutive failed runs before the owner is notified.
	backupFailNotifyThreshold = 2
	// backupFailRenotifyEvery re-alerts during a long outage (36 ticks of 10 min ~ 6 h) without spamming.
	backupFailRenotifyEvery = 36
	// backupAlertHTTPTimeout bounds the heartbeat ping and the notification POST.
	backupAlertHTTPTimeout = 10 * time.Second

	notificationTitleMaxLen = 300
	notificationBodyMaxLen  = 5000
	notificationErrMaxLen   = 1500
)

// shouldNotifyBackupFailure reports whether a failure streak of the given length warrants an alert:
// at the threshold, then every backupFailRenotifyEvery further failures.
func shouldNotifyBackupFailure(streak int) bool {
	if streak < backupFailNotifyThreshold {
		return false
	}
	return (streak-backupFailNotifyThreshold)%backupFailRenotifyEvery == 0
}

// pingHeartbeat sends GET to a dead-man's-switch URL (e.g. healthchecks.io). An empty URL is a no-op.
func pingHeartbeat(ctx context.Context, client *http.Client, heartbeatURL string) error {
	heartbeatURL = strings.TrimSpace(heartbeatURL)
	if heartbeatURL == "" {
		return nil
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, heartbeatURL, nil)
	if err != nil {
		return fmt.Errorf("create heartbeat request: %w", err)
	}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return fmt.Errorf("heartbeat returned status %d", resp.StatusCode)
	}
	return nil
}

// storeLocation returns the store timezone for human-readable timestamps; the alpine runtime image
// may lack tzdata, so fall back to a fixed UTC+7 zone instead of showing container (UTC) time.
func storeLocation() *time.Location {
	if loc, err := time.LoadLocation("Asia/Ho_Chi_Minh"); err == nil {
		return loc
	}
	return time.FixedZone("ICT", 7*3600)
}

func truncateRunes(s string, max int) string {
	r := []rune(s)
	if len(r) <= max {
		return s
	}
	return string(r[:max-1]) + "…"
}

// sendBackupFailureNotification asks the Notification Service to create an in-app + email alert.
func sendBackupFailureNotification(
	ctx context.Context,
	client *http.Client,
	baseURL string,
	apiKey string,
	streak int,
	lastErr error,
) error {
	errText := "không rõ"
	if lastErr != nil {
		errText = truncateRunes(lastErr.Error(), notificationErrMaxLen)
	}
	title := truncateRunes(fmt.Sprintf("Sao lưu tự động thất bại %d lần liên tiếp", streak), notificationTitleMaxLen)
	body := truncateRunes(fmt.Sprintf(
		"Sao lưu tự động của Pharmar đã thất bại %d lần liên tiếp (lúc %s).\n\n"+
			"Lỗi gần nhất: %s\n\n"+
			"Cách kiểm tra: xem log Store service (docker logs pharmar-store-service | grep BACKUP_FAILED) "+
			"và kiểm tra kết nối R2 / File Service.",
		streak,
		time.Now().In(storeLocation()).Format("02/01/2006 15:04 MST"),
		errText,
	), notificationBodyMaxLen)

	payload, err := json.Marshal(map[string]any{
		"title":      title,
		"body":       body,
		"category":   "system",
		"send_email": true,
	})
	if err != nil {
		return fmt.Errorf("marshal notification: %w", err)
	}

	endpoint := strings.TrimRight(strings.TrimSpace(baseURL), "/") + "/api/v1/notification/internal/send"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(payload))
	if err != nil {
		return fmt.Errorf("create notification request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Internal-API-Key", apiKey)

	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return fmt.Errorf("notification service returned %d: %s", resp.StatusCode, strings.TrimSpace(string(respBody)))
	}
	return nil
}

func (s *Service) backupAlertClient() *http.Client {
	if s.alertClient != nil {
		return s.alertClient
	}
	return &http.Client{Timeout: backupAlertHTTPTimeout}
}

func (s *Service) backupHeartbeatURL(ctx context.Context) string {
	if s.heartbeatURLFn != nil {
		return s.heartbeatURLFn(ctx)
	}
	settings, err := s.GetSettingsByGroup(ctx, "backup")
	if err != nil {
		return ""
	}
	raw, _ := settings["backup.heartbeat_url"].(string)
	return strings.TrimSpace(raw)
}

// onBackupSuccess resets the failure streak and pings the heartbeat URL (if configured).
// Failures here are only logged and never affect the backup result.
func (s *Service) onBackupSuccess(ctx context.Context) {
	s.backupFailStreak = 0

	heartbeatURL := s.backupHeartbeatURL(ctx)
	if heartbeatURL == "" {
		return
	}
	pingCtx, cancel := context.WithTimeout(ctx, backupAlertHTTPTimeout)
	defer cancel()
	if err := pingHeartbeat(pingCtx, s.backupAlertClient(), heartbeatURL); err != nil {
		log.Printf("backup heartbeat failed: %v", err)
	}
}

// onBackupFailure logs the failure, bumps the streak and notifies the owner when due.
func (s *Service) onBackupFailure(ctx context.Context, stage string, err error) {
	log.Printf("BACKUP_FAILED: %s: %v", stage, err)
	s.backupFailStreak++

	if !shouldNotifyBackupFailure(s.backupFailStreak) {
		return
	}
	baseURL := strings.TrimSpace(s.cfg.NotificationServiceURL)
	apiKey := strings.TrimSpace(s.cfg.NotificationInternalAPIKey)
	if baseURL == "" || apiKey == "" {
		if !s.backupNotifyConfigWarned {
			s.backupNotifyConfigWarned = true
			log.Printf("backup alert: NOTIFICATION_SERVICE_URL / NOTIFICATION_INTERNAL_API_KEY not configured, skipping failure notification")
		}
		return
	}

	notifyCtx, cancel := context.WithTimeout(ctx, backupAlertHTTPTimeout)
	defer cancel()
	if notifyErr := sendBackupFailureNotification(notifyCtx, s.backupAlertClient(), baseURL, apiKey, s.backupFailStreak, err); notifyErr != nil {
		log.Printf("backup alert: failed to send failure notification: %v", notifyErr)
	}
}
