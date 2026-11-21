#!/usr/bin/env bash
# 로컬 시험 스택 시작 (Docker 이미지를 받을 수 없는 환경용)
#   PostgreSQL 16 + pgTAP + Supabase Auth(GoTrue 바이너리) + PostgREST + 게이트웨이(127.0.0.1:54321)
# 필요: /usr/lib/postgresql/16/bin, postgrest(v12), GoTrue 바이너리(GOTRUE_BIN), node 20+
# 모든 데이터·키는 LOCAL_STACK_DIR(기본 /tmp/yakhyo-mcp-local)에만 생기며 저장소에 쓰지 않는다.
# Docker가 되는 환경에서는 대신 `supabase start`를 쓴다.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
export LOCAL_STACK_DIR="${LOCAL_STACK_DIR:-/tmp/yakhyo-mcp-local}"
DIR="$LOCAL_STACK_DIR"
PGBIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
GOTRUE_BIN="${GOTRUE_BIN:-/opt/gotrue/auth}"
GOTRUE_MIGRATIONS="${GOTRUE_MIGRATIONS:-$(dirname "$GOTRUE_BIN")/migrations}"
PG_PORT=54322; GW_PORT=54321; PGRST_PORT=54330; GOTRUE_PORT=54331

case "$DIR" in /tmp/*|/var/tmp/*) ;; *) echo "LOCAL_STACK_DIR은 /tmp 아래여야 합니다" >&2; exit 1;; esac
if [[ "${1:-}" == "--reset" ]]; then "$HERE/stop.sh" || true; rm -rf "$DIR"; fi
mkdir -p "$DIR"; chmod 700 "$DIR"

node "$HERE/init-keys.mjs" "$DIR" "$PG_PORT" "$GW_PORT" "$PGRST_PORT" "$GOTRUE_PORT"

run_pg() { runuser -u postgres -- "$@"; }
if [[ ! -d "$DIR/pg" ]]; then
  mkdir -p "$DIR/pg"; chown postgres "$DIR" "$DIR/pg"
  run_pg "$PGBIN/initdb" -D "$DIR/pg" -U postgres --auth=trust -E UTF8 --locale=C.UTF-8 >/dev/null
  cat >> "$DIR/pg/postgresql.conf" <<EOF
listen_addresses = '127.0.0.1'
port = $PG_PORT
unix_socket_directories = '$DIR'
timezone = 'UTC'
EOF
fi
chown postgres "$DIR"
if ! run_pg "$PGBIN/pg_ctl" -D "$DIR/pg" status >/dev/null 2>&1; then
  run_pg "$PGBIN/pg_ctl" -D "$DIR/pg" -l "$DIR/pg.log" -w start >/dev/null
fi
PSQL=(psql -h 127.0.0.1 -p "$PG_PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 -q)
"${PSQL[@]}" -f "$HERE/bootstrap.sql"
"${PSQL[@]}" -c "create extension if not exists pgtap with schema extensions" >/dev/null 2>&1 || true

# Supabase Auth (GoTrue) — 자체 마이그레이션 실행 후 서비스
if ! curl -sf "http://127.0.0.1:$GOTRUE_PORT/health" >/dev/null 2>&1; then
  ( cd "$(dirname "$GOTRUE_BIN")"
    env -i PATH="$PATH" HOME="$DIR" \
      GOTRUE_API_HOST=127.0.0.1 PORT="$GOTRUE_PORT" API_EXTERNAL_URL="http://127.0.0.1:$GW_PORT/auth/v1" \
      GOTRUE_SITE_URL="http://127.0.0.1:8080" \
      GOTRUE_DB_DRIVER=postgres \
      GOTRUE_DB_DATABASE_URL="postgres://supabase_auth_admin:local-auth-admin@127.0.0.1:$PG_PORT/postgres?search_path=auth&sslmode=disable" \
      GOTRUE_DB_MIGRATIONS_PATH="$GOTRUE_MIGRATIONS" \
      GOTRUE_JWT_SECRET="$(cat "$DIR/legacy-hs-secret")" \
      GOTRUE_JWT_KEYS="$(cat "$DIR/signing-keys.json")" \
      GOTRUE_JWT_ISSUER="http://127.0.0.1:$GW_PORT/auth/v1" \
      GOTRUE_JWT_AUD=authenticated GOTRUE_JWT_EXP=900 GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated \
      GOTRUE_JWT_ADMIN_ROLES=service_role \
      GOTRUE_DISABLE_SIGNUP=true GOTRUE_EXTERNAL_EMAIL_ENABLED=true GOTRUE_MAILER_AUTOCONFIRM=true \
      GOTRUE_EXTERNAL_ANONYMOUS_USERS_ENABLED=false GOTRUE_PASSWORD_MIN_LENGTH=12 \
      GOTRUE_RATE_LIMIT_TOKEN_REFRESH=10000 GOTRUE_RATE_LIMIT_VERIFY=10000 \
      GOTRUE_LOG_LEVEL=warn \
      sh -c '"$0" migrate >"$1/gotrue-migrate.log" 2>&1 && exec "$0" serve' "$GOTRUE_BIN" "$DIR" >"$DIR/gotrue.log" 2>&1 &
    echo $! >"$DIR/gotrue.pid" )
  for _ in $(seq 1 60); do curl -sf "http://127.0.0.1:$GOTRUE_PORT/health" >/dev/null 2>&1 && break; sleep 0.5; done
  curl -sf "http://127.0.0.1:$GOTRUE_PORT/health" >/dev/null || { echo "GoTrue 시작 실패: $DIR/gotrue.log" >&2; tail -20 "$DIR/gotrue.log" >&2; exit 1; }
fi

# 앱 마이그레이션 (추가 전용, 적용 기록)
"${PSQL[@]}" -c "create table if not exists public._local_migrations(name text primary key, applied_at timestamptz default now()); revoke all on public._local_migrations from anon, authenticated;"
for f in "$ROOT"/supabase/migrations/*.sql; do
  name="$(basename "$f")"
  if [[ -z "$("${PSQL[@]}" -tAc "select 1 from public._local_migrations where name='$name'")" ]]; then
    "${PSQL[@]}" -1 -f "$f"
    "${PSQL[@]}" -c "insert into public._local_migrations(name) values ('$name')"
    echo "applied $name"
  fi
done

# PostgREST
if ! curl -sf "http://127.0.0.1:$PGRST_PORT/" >/dev/null 2>&1; then
  cat > "$DIR/postgrest.conf" <<EOF
db-uri = "postgres://authenticator:local-authenticator@127.0.0.1:$PG_PORT/postgres"
db-schemas = "public"
db-anon-role = "anon"
db-extra-search-path = "public, extensions"
db-max-rows = 1000
server-host = "127.0.0.1"
server-port = $PGRST_PORT
jwt-secret = "@$DIR/jwks.json"
jwt-aud = ""
log-level = "error"
EOF
  nohup postgrest "$DIR/postgrest.conf" >"$DIR/postgrest.log" 2>&1 & echo $! >"$DIR/postgrest.pid"
  for _ in $(seq 1 40); do curl -sf "http://127.0.0.1:$PGRST_PORT/" >/dev/null 2>&1 && break; sleep 0.25; done
else
  kill -USR1 "$(cat "$DIR/postgrest.pid")" 2>/dev/null || true
fi

if ! curl -s "http://127.0.0.1:$GW_PORT/" >/dev/null 2>&1; then
  nohup node "$HERE/gateway.mjs" >"$DIR/gateway.log" 2>&1 & echo $! >"$DIR/gateway.pid"
  sleep 0.5
fi
echo "local stack ready: http://127.0.0.1:$GW_PORT  (config: $DIR/stack.json)"
