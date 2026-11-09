#!/usr/bin/env bash
# Post one island status event. Usage: post-event.sh <bot_id> <type> "<text>" [value]
# Loads ISLAND_WRITE_KEY from /workspace/.secrets/grok-bot-worlds.env
# Never prints the write key. Always exits 0 so callers are not blocked by status updates.

set -u
BOT_ID="${1:-}"
TYPE="${2:-}"
TEXT="${3:-}"
VALUE="${4:-}"

if [[ -z "$BOT_ID" || -z "$TYPE" ]]; then
  echo "usage: post-event.sh <bot_id> <type> \"<text>\" [value]" >&2
  exit 0
fi

SECRETS="/workspace/.secrets/grok-bot-worlds.env"
if [[ ! -f "$SECRETS" ]]; then
  echo "post-event: secrets file missing; skipped" >&2
  exit 0
fi

# shellcheck disable=SC1090
set -a
# shellcheck disable=SC1091
source "$SECRETS"
set +a

if [[ -z "${ISLAND_WRITE_KEY:-}" || -z "${SUPABASE_PROJECT_URL:-}" || -z "${SUPABASE_ANON_KEY:-}" ]]; then
  echo "post-event: incomplete secrets; skipped" >&2
  exit 0
fi

URL="${SUPABASE_PROJECT_URL%/}/rest/v1/rpc/post_event"

# Build JSON without embedding secrets in process list via env for the key only inside python
export _PE_BOT="$BOT_ID" _PE_TYPE="$TYPE" _PE_TEXT="$TEXT" _PE_VALUE="$VALUE"
BODY=$(python3 - <<'PY'
import json, os
payload = {
  "write_key": os.environ["ISLAND_WRITE_KEY"],
  "bot_id": os.environ["_PE_BOT"],
  "type": os.environ["_PE_TYPE"],
  "text": (os.environ.get("_PE_TEXT") or "")[:200],
}
v = os.environ.get("_PE_VALUE") or ""
if v != "":
  try:
    payload["value"] = float(v)
  except ValueError:
    pass
print(json.dumps(payload))
PY
)
unset _PE_BOT _PE_TYPE _PE_TEXT _PE_VALUE

HTTP_CODE=$(curl -sS -o /tmp/gbw-post-event.out -w '%{http_code}' \
  --connect-timeout 3 --max-time 8 \
  -X POST "$URL" \
  -H "apikey: ${SUPABASE_ANON_KEY}" \
  -H "Authorization: Bearer ${SUPABASE_ANON_KEY}" \
  -H "Content-Type: application/json" \
  -d "$BODY" 2>/tmp/gbw-post-event.err || true)

if [[ "${HTTP_CODE}" == "200" || "${HTTP_CODE}" == "201" ]]; then
  echo "post-event: ok ${BOT_ID} ${TYPE}"
else
  echo "post-event: skipped (${HTTP_CODE:-net-fail}) ${BOT_ID} ${TYPE}" >&2
fi
exit 0
