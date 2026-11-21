#!/usr/bin/env bash
# 전체 검증(로컬): 스택 초기화 → DB(pgTAP·Data API) → Worker(타입·단위·workerd 통합) → Pages(기존·브리지·브라우저 통합)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"; cd "$ROOT"
export LOCAL_STACK_DIR="${LOCAL_STACK_DIR:-/tmp/yakhyo-mcp-local}"
tools/local-stack/start.sh --reset
node tools/local-stack/seed.mjs
echo "== DB: pgTAP"; tools/local-stack/run-pgtap.sh | tail -1
echo "== DB: Data API"; node --test supabase/tests-api/data-api.test.mjs 2>&1 | grep -E '^# (pass|fail)'
echo "== Worker"; npm --prefix workers/mcp run typecheck --silent && npm --prefix workers/mcp test --silent 2>&1 | grep -E 'Tests'
PK=$(node -pe "require('$LOCAL_STACK_DIR/stack.json').publishableKey")
( cd workers/mcp && WRANGLER_SEND_METRICS=false npx wrangler dev --env staging --port 8787 --ip 127.0.0.1 \
    --var SUPABASE_URL:http://127.0.0.1:54321 --var SUPABASE_PUBLISHABLE_KEY:"$PK" --var ALLOWED_ORIGINS:http://127.0.0.1:8080 \
    > "$LOCAL_STACK_DIR/wrangler-dev.log" 2>&1 & echo $! > "$LOCAL_STACK_DIR/wrangler.pid" )
for _ in $(seq 1 60); do curl -sf http://127.0.0.1:8787/healthz >/dev/null 2>&1 && break; sleep 1; done
echo "== Worker 통합(workerd + 로컬 Supabase)"; npm --prefix workers/mcp run test:integration --silent 2>&1 | grep -E 'Tests'
kill "$(cat "$LOCAL_STACK_DIR/wrangler.pid")" 2>/dev/null || true
echo "== Pages"; for t in tests/*.test.js; do printf '%s ' "$t"; node "$t" 2>&1 | grep RESULT; done
node tests/cloud-bridge.integration.test.js 2>&1 | grep RESULT
