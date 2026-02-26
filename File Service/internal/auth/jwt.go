package auth

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/golang-jwt/jwt/v5"

	"file-service/internal/config"
)

type contextKey string

const claimsContextKey contextKey = "file_claims"

type Claims struct {
	Role string `json:"role"`
	Type string `json:"type"`
	jwt.RegisteredClaims
}

var (
	ErrMissingAuthHeader = errors.New("missing authorization header")
	ErrInvalidToken      = errors.New("invalid token")
	ErrForbidden         = errors.New("insufficient permissions")
)

func ParseBearerToken(authHeader string, cfg config.Config) (*Claims, error) {
	if strings.TrimSpace(authHeader) == "" {
		return nil, ErrMissingAuthHeader
	}

	parts := strings.SplitN(authHeader, " ", 2)
	if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
		return nil, ErrMissingAuthHeader
	}

	tokenString := strings.TrimSpace(parts[1])
	if tokenString == "" {
		return nil, ErrMissingAuthHeader
	}

	claims := &Claims{}
	token, err := jwt.ParseWithClaims(tokenString, claims, func(token *jwt.Token) (any, error) {
		if token.Method.Alg() != cfg.JWTAlgorithm {
			return nil, fmt.Errorf("unexpected signing method: %s", token.Method.Alg())
		}
		return []byte(cfg.JWTSecretKey), nil
	})
	if err != nil || !token.Valid {
		return nil, ErrInvalidToken
	}

	if claims.Type != "" && claims.Type != "access" {
		return nil, ErrInvalidToken
	}

	if strings.TrimSpace(claims.Subject) == "" {
		return nil, ErrInvalidToken
	}

	return claims, nil
}

// Authenticated requires any valid JWT token.
func Authenticated(cfg config.Config) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			claims, err := ParseBearerToken(r.Header.Get("Authorization"), cfg)
			if err != nil {
				writeError(w, http.StatusUnauthorized, "Invalid token")
				return
			}
			ctx := context.WithValue(r.Context(), claimsContextKey, claims)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// OwnerOnly requires the token role to be "owner" or "admin".
func OwnerOnly(cfg config.Config) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			claims, err := ParseBearerToken(r.Header.Get("Authorization"), cfg)
			if err != nil {
				writeError(w, http.StatusUnauthorized, "Invalid token")
				return
			}
			role := strings.ToLower(strings.TrimSpace(claims.Role))
			if role != "owner" && role != "admin" {
				writeError(w, http.StatusForbidden, "Only owner/admin is allowed")
				return
			}

			ctx := context.WithValue(r.Context(), claimsContextKey, claims)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

func ClaimsFromContext(ctx context.Context) (*Claims, bool) {
	claims, ok := ctx.Value(claimsContextKey).(*Claims)
	return claims, ok
}

func writeError(w http.ResponseWriter, status int, detail string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write([]byte(fmt.Sprintf(`{"detail":%q}`, detail)))
}
