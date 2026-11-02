package app

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"store-service/internal/config"
)

func TestShouldNotifyBackupFailure(t *testing.T) {
	for _, streak := range []int{0, 1} {
		if shouldNotifyBackupFailure(streak) {
			t.Errorf("streak %d should not notify", streak)
		}
	}
	if !shouldNotifyBackupFailure(2) {
		t.Error("streak 2 should notify")
	}
	for streak := 3; streak <= 37; streak++ {
		if shouldNotifyBackupFailure(streak) {
			t.Errorf("streak %d should not notify", streak)
		}
	}
	for _, streak := range []int{38, 74} {
		if !shouldNotifyBackupFailure(streak) {
			t.Errorf("streak %d should notify", streak)
		}
	}
}

func TestPingHeartbeat(t *testing.T) {
	var hits int32
	var method string
	ok := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&hits, 1)
		method = r.Method
		w.WriteHeader(http.StatusOK)
	}))
	defer ok.Close()

	if err := pingHeartbeat(context.Background(), ok.Client(), ok.URL+"/ping/abc"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got := atomic.LoadInt32(&hits); got != 1 {
		t.Errorf("hits = %d, want 1", got)
	}
	if method != http.MethodGet {
		t.Errorf("method = %s, want GET", method)
	}

	failing := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer failing.Close()
	if err := pingHeartbeat(context.Background(), failing.Client(), failing.URL); err == nil {
		t.Error("expected error on 500")
	}

	dead := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	deadURL := dead.URL
	dead.Close()
	if err := pingHeartbeat(context.Background(), http.DefaultClient, deadURL); err == nil {
		t.Error("expected error on unreachable URL")
	}

	before := atomic.LoadInt32(&hits)
	if err := pingHeartbeat(context.Background(), ok.Client(), "  "); err != nil {
		t.Errorf("empty URL should be nil, got %v", err)
	}
	if atomic.LoadInt32(&hits) != before {
		t.Error("empty URL must not send a request")
	}
}

func TestSendBackupFailureNotification(t *testing.T) {
	var gotMethod, gotPath, gotKey, gotCT string
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod, gotPath = r.Method, r.URL.Path
		gotKey = r.Header.Get("X-Internal-API-Key")
		gotCT = r.Header.Get("Content-Type")
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		if gotKey != "secret" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	err := sendBackupFailureNotification(context.Background(), srv.Client(), srv.URL+"/", "secret", 7, errors.New("r2 down"))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if gotMethod != http.MethodPost {
		t.Errorf("method = %s", gotMethod)
	}
	if gotPath != "/api/v1/notification/internal/send" {
		t.Errorf("path = %s", gotPath)
	}
	if gotKey != "secret" {
		t.Errorf("api key header = %q", gotKey)
	}
	if !strings.HasPrefix(gotCT, "application/json") {
		t.Errorf("content-type = %q", gotCT)
	}
	if gotBody["category"] != "system" {
		t.Errorf("category = %v", gotBody["category"])
	}
	if gotBody["send_email"] != true {
		t.Errorf("send_email = %v", gotBody["send_email"])
	}
	title, _ := gotBody["title"].(string)
	body, _ := gotBody["body"].(string)
	if !strings.Contains(title, "7") {
		t.Errorf("title %q should contain streak", title)
	}
	if !strings.Contains(body, "r2 down") || !strings.Contains(body, "BACKUP_FAILED") {
		t.Errorf("body missing error text or log hint: %q", body)
	}
	if len([]rune(title)) > notificationTitleMaxLen || len([]rune(body)) > notificationBodyMaxLen {
		t.Error("title/body exceed limits")
	}

	if err := sendBackupFailureNotification(context.Background(), srv.Client(), srv.URL, "wrong", 2, errors.New("x")); err == nil {
		t.Error("expected error on 401")
	}
}

func TestBackupFailureStreakBookkeeping(t *testing.T) {
	var notifications int32
	var lastTitle atomic.Value
	notifier := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&notifications, 1)
		var payload map[string]any
		_ = json.NewDecoder(r.Body).Decode(&payload)
		lastTitle.Store(payload["title"])
		w.WriteHeader(http.StatusOK)
	}))
	defer notifier.Close()

	var heartbeats int32
	beat := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&heartbeats, 1)
		w.WriteHeader(http.StatusOK)
	}))
	defer beat.Close()

	svc := &Service{
		cfg: config.Config{
			NotificationServiceURL:     notifier.URL,
			NotificationInternalAPIKey: "k",
		},
		alertClient:    notifier.Client(),
		heartbeatURLFn: func(context.Context) string { return beat.URL },
	}
	ctx := context.Background()

	svc.onBackupFailure(ctx, "stage", errors.New("boom"))
	if svc.backupFailStreak != 1 || atomic.LoadInt32(&notifications) != 0 {
		t.Fatalf("after 1 failure: streak=%d notifications=%d", svc.backupFailStreak, notifications)
	}
	svc.onBackupFailure(ctx, "stage", errors.New("boom"))
	if svc.backupFailStreak != 2 || atomic.LoadInt32(&notifications) != 1 {
		t.Fatalf("after 2 failures: streak=%d notifications=%d", svc.backupFailStreak, notifications)
	}
	if title, _ := lastTitle.Load().(string); !strings.Contains(title, "2") {
		t.Errorf("title = %q", title)
	}
	svc.onBackupFailure(ctx, "stage", errors.New("boom"))
	if atomic.LoadInt32(&notifications) != 1 {
		t.Errorf("third failure must not re-notify, got %d", notifications)
	}

	svc.onBackupSuccess(ctx)
	if svc.backupFailStreak != 0 {
		t.Errorf("streak not reset: %d", svc.backupFailStreak)
	}
	if atomic.LoadInt32(&heartbeats) != 1 {
		t.Errorf("heartbeats = %d, want 1", heartbeats)
	}

	// Missing config: no request, no panic, warns once.
	bare := &Service{}
	bare.onBackupFailure(ctx, "stage", errors.New("boom"))
	bare.onBackupFailure(ctx, "stage", errors.New("boom"))
	if !bare.backupNotifyConfigWarned || bare.backupFailStreak != 2 {
		t.Errorf("bare service: warned=%v streak=%d", bare.backupNotifyConfigWarned, bare.backupFailStreak)
	}

	// Empty heartbeat URL: success still resets streak without any request.
	svc.heartbeatURLFn = func(context.Context) string { return "" }
	svc.backupFailStreak = 5
	svc.onBackupSuccess(ctx)
	if svc.backupFailStreak != 0 || atomic.LoadInt32(&heartbeats) != 1 {
		t.Errorf("streak=%d heartbeats=%d", svc.backupFailStreak, heartbeats)
	}
}
