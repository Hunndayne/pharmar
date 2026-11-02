#!/usr/bin/env bash
# Deploy Pharmar lên server (chạy trong ~/pharmar-management).
#
# Cách dùng:
#   ./deploy.sh                              # pull + build + up toàn bộ service
#   ./deploy.sh inventory-service frontend   # chỉ build/up các service chỉ định
#   ./deploy.sh --no-pull sale-service       # bỏ qua git pull
#
# Script an toàn khi chạy lại nhiều lần. KHÔNG bao giờ ghi đè FrontEnd/nginx.conf của server.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

COMPOSE_FILE="docker-compose.microservices.yml"
COMPOSE=(docker compose -f "$COMPOSE_FILE")
BACKUP_DIR="$HOME/pharmar-backups"
NGINX_CONF="FrontEnd/nginx.conf"
NGINX_BAK="/tmp/nginx.conf.server.bak"
KEEP_BACKUPS=10
HEALTH_TIMEOUT=180
PG_CONTAINER="pharmar-postgres"

DO_PULL=1
SERVICES=()
for arg in "$@"; do
  case "$arg" in
    --no-pull) DO_PULL=0 ;;
    -h|--help)
      sed -n '2,9p' "$0"
      exit 0
      ;;
    -*)
      echo "Tham số không hợp lệ: $arg" >&2
      exit 2
      ;;
    *) SERVICES+=("$arg") ;;
  esac
done

log()  { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m[CẢNH BÁO] %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[1;31m[LỖI] %s\033[0m\n' "$*" >&2; exit 1; }

# Danh sách service: mặc định là tất cả service trong compose file.
mapfile -t KNOWN < <("${COMPOSE[@]}" config --services)
if [ ${#SERVICES[@]} -eq 0 ]; then
  SERVICES=("${KNOWN[@]}")
else
  # Kiểm tra tên service hợp lệ trước khi làm bất cứ điều gì.
  for s in "${SERVICES[@]}"; do
    printf '%s\n' "${KNOWN[@]}" | grep -qx -- "$s" || die "Service không tồn tại trong $COMPOSE_FILE: $s"
  done
fi
echo "Service sẽ deploy: ${SERVICES[*]}"

# ---------------------------------------------------------------------------
# 1-3. Giữ nguyên nginx.conf của server rồi git pull
# ---------------------------------------------------------------------------
STASHED=0

restore_nginx_if_needed() {
  # Dù pull/stash thế nào, nginx.conf của server phải giống bản đã sao lưu.
  if [ -f "$NGINX_BAK" ] && ! cmp -s "$NGINX_BAK" "$NGINX_CONF"; then
    warn "$NGINX_CONF khác bản server đã sao lưu - khôi phục từ $NGINX_BAK"
    cp "$NGINX_BAK" "$NGINX_CONF"
  fi
}

cp "$NGINX_CONF" "$NGINX_BAK"
echo "Đã sao lưu $NGINX_CONF -> $NGINX_BAK"

if [ "$DO_PULL" -eq 1 ]; then
  log "Cập nhật code (git pull --ff-only)"

  if [ -n "$(git status --porcelain -- "$NGINX_CONF")" ]; then
    git stash push -m "deploy: nginx.conf server" -- "$NGINX_CONF"
    STASHED=1
  fi

  if ! git pull --ff-only; then
    if [ "$STASHED" -eq 1 ]; then
      git stash pop || warn "Không pop được stash - bản nginx.conf server vẫn nằm trong 'git stash list' và $NGINX_BAK"
    fi
    restore_nginx_if_needed
    die "git pull --ff-only thất bại (nhánh đã phân kỳ?). Chưa thay đổi container nào."
  fi

  if [ "$STASHED" -eq 1 ]; then
    if ! git stash pop; then
      restore_nginx_if_needed
      die "Xung đột khi áp lại $NGINX_CONF sau pull. Đã khôi phục bản server từ $NGINX_BAK; hãy xử lý xung đột (git status / git stash list) rồi chạy lại với --no-pull."
    fi
  fi
  restore_nginx_if_needed
else
  log "Bỏ qua git pull (--no-pull)"
fi

# ---------------------------------------------------------------------------
# 4. Backup toàn bộ Postgres trước khi đổi container
# ---------------------------------------------------------------------------
log "Backup Postgres"
mkdir -p "$BACKUP_DIR"
BACKUP_FILE="$BACKUP_DIR/pre-deploy_$(date +%Y%m%d-%H%M%S).sql.gz"
if ! docker exec "$PG_CONTAINER" pg_dumpall -U postgres | gzip > "$BACKUP_FILE.tmp"; then
  rm -f "$BACKUP_FILE.tmp"
  die "Backup thất bại - dừng deploy, container chưa bị đổi."
fi
mv "$BACKUP_FILE.tmp" "$BACKUP_FILE"
[ -s "$BACKUP_FILE" ] || die "File backup rỗng: $BACKUP_FILE"
echo "Backup: $BACKUP_FILE ($(du -h "$BACKUP_FILE" | cut -f1))"

# Giữ lại $KEEP_BACKUPS bản mới nhất.
ls -1t "$BACKUP_DIR"/pre-deploy_*.sql.gz 2>/dev/null | tail -n +$((KEEP_BACKUPS + 1)) | while read -r old; do
  rm -f -- "$old"
done

# ---------------------------------------------------------------------------
# 5. Số liệu trước khi deploy
# ---------------------------------------------------------------------------
psql_scalar() { # $1=database $2=sql ; in rỗng nếu lỗi (vd bảng chưa tồn tại)
  docker exec "$PG_CONTAINER" psql -U postgres -d "$1" -tAc "$2" 2>/dev/null | tr -d '[:space:]' || true
}

collect_counts() { # $1=file đích
  {
    echo "inventory_drugs=$(psql_scalar pharmar_inventory 'select count(*) from inventory_drugs')"
    echo "inventory_batches=$(psql_scalar pharmar_inventory 'select count(*) from inventory_batches')"
    echo "inventory_qty_remaining=$(psql_scalar pharmar_inventory "select coalesce(sum((data->>'qty_remaining')::int),0) from inventory_batches where coalesce(data->>'cancelled','false')='false'")"
    echo "sale_invoices=$(psql_scalar pharmar_sale 'select count(*) from sale.invoices')"
  } | sed 's/=$/=n\/a/' > "$1"
}

log "Số liệu trước deploy"
collect_counts "$BACKUP_DIR/counts_before.txt"
cat "$BACKUP_DIR/counts_before.txt"

# ---------------------------------------------------------------------------
# 6. Build + up
# ---------------------------------------------------------------------------
log "Build image"
"${COMPOSE[@]}" build "${SERVICES[@]}"

log "Khởi động container"
"${COMPOSE[@]}" up -d --remove-orphans "${SERVICES[@]}"

# ---------------------------------------------------------------------------
# 7. Chờ container healthy
# ---------------------------------------------------------------------------
log "Chờ container sẵn sàng (tối đa ${HEALTH_TIMEOUT}s)"

container_state() { # $1=container id -> "tên|trạng thái"
  local id="$1" name running health exit_code
  name=$(docker inspect --format '{{.Name}}' "$id" | sed 's#^/##')
  running=$(docker inspect --format '{{.State.Status}}' "$id")
  health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$id")
  exit_code=$(docker inspect --format '{{.State.ExitCode}}' "$id")
  if [ "$running" = "exited" ] && [ "$exit_code" = "0" ]; then
    echo "$name|done (exit 0)"     # job một lần như db-bootstrap
  elif [ "$running" != "running" ]; then
    echo "$name|$running"
  elif [ "$health" = "none" ]; then
    echo "$name|running (no healthcheck)"
  else
    echo "$name|$health"
  fi
}

is_ok_state() {
  case "$1" in
    healthy|"done (exit 0)"|"running (no healthcheck)") return 0 ;;
    *) return 1 ;;
  esac
}

mapfile -t CONTAINER_IDS < <("${COMPOSE[@]}" ps -a -q "${SERVICES[@]}")
deadline=$((SECONDS + HEALTH_TIMEOUT))
ALL_OK=0
TABLE=""
while :; do
  ALL_OK=1
  TABLE=""
  for id in "${CONTAINER_IDS[@]}"; do
    [ -n "$id" ] || continue
    row=$(container_state "$id")
    TABLE+="$row"$'\n'
    is_ok_state "${row#*|}" || ALL_OK=0
  done
  [ "$ALL_OK" -eq 1 ] && break
  [ "$SECONDS" -ge "$deadline" ] && break
  sleep 3
done

printf '%-36s %s\n' "CONTAINER" "TRẠNG THÁI"
printf '%s' "$TABLE" | while IFS='|' read -r n st; do
  [ -z "$n" ] || printf '%-36s %s\n' "$n" "$st"
done
if [ "$ALL_OK" -ne 1 ]; then
  warn "Có container chưa healthy sau ${HEALTH_TIMEOUT}s. Xem log: docker compose -f $COMPOSE_FILE logs --tail=100 <service>"
fi

# ---------------------------------------------------------------------------
# 8. So sánh số liệu trước/sau
# ---------------------------------------------------------------------------
log "Số liệu sau deploy"
collect_counts "$BACKUP_DIR/counts_after.txt"
echo "(trái = trước, phải = sau)"
diff -y --width=70 "$BACKUP_DIR/counts_before.txt" "$BACKUP_DIR/counts_after.txt" || true

INV_CHANGED=0
for key in inventory_drugs inventory_batches inventory_qty_remaining; do
  b=$(grep "^$key=" "$BACKUP_DIR/counts_before.txt" || true)
  a=$(grep "^$key=" "$BACKUP_DIR/counts_after.txt" || true)
  [ "$a" = "$b" ] || INV_CHANGED=1
done
if [ "$INV_CHANGED" -eq 1 ]; then
  printf '\033[1;31m'
  echo "################################################################"
  echo "# CẢNH BÁO: SỐ LIỆU TỒN KHO ĐÃ THAY ĐỔI SAU DEPLOY!"
  echo "# Kiểm tra ngay; có thể khôi phục từ: $BACKUP_FILE"
  echo "################################################################"
  printf '\033[0m'
else
  echo "Số liệu tồn kho không đổi."
fi

# ---------------------------------------------------------------------------
# 9. Dọn image cũ
# ---------------------------------------------------------------------------
log "Dọn image không dùng"
docker image prune -f

[ "$ALL_OK" -eq 1 ] || exit 1
echo
echo "Deploy hoàn tất."
