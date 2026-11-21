#!/usr/bin/env bash
set -uo pipefail
DIR="${LOCAL_STACK_DIR:-/tmp/yakhyo-mcp-local}"
for p in gateway postgrest gotrue; do
  [[ -f "$DIR/$p.pid" ]] && kill "$(cat "$DIR/$p.pid")" 2>/dev/null; rm -f "$DIR/$p.pid"
done
[[ -d "$DIR/pg" ]] && runuser -u postgres -- /usr/lib/postgresql/16/bin/pg_ctl -D "$DIR/pg" -m fast stop >/dev/null 2>&1
echo stopped
