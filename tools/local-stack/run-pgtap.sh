#!/usr/bin/env bash
# 로컬 스택 DB에 pgTAP 테스트 실행 (Docker 환경에서는 `supabase test db` 사용)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
out=""
for f in "$ROOT"/supabase/tests/*.test.sql; do
  out+="$(psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -X -q -t -f "$f" 2>&1)"$'\n'
done
echo "$out" | sed 's/^ //' | grep -E '^(ok|not ok|#|1\.\.)|ERROR' || true
if echo "$out" | grep -qE '^ ?not ok|ERROR|Looks like'; then echo "pgTAP FAILED"; exit 1; fi
echo "pgTAP PASSED"
