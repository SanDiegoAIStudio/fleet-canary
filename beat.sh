#!/bin/bash
# Post a heartbeat for this machine to a fleet-canary Worker.
# Required environment: CANARY_URL, CANARY_SECRET.
# Optional: CANARY_HOST, which defaults to the short hostname.

set -u

if [ -z "${CANARY_URL:-}" ]; then
  echo "ERROR: CANARY_URL is unset. Set it to the Worker origin." >&2
  exit 2
fi

if [ -z "${CANARY_SECRET:-}" ]; then
  echo "ERROR: CANARY_SECRET is unset. Set it to the Worker BEAT_SECRET." >&2
  exit 2
fi

HOST="${CANARY_HOST:-$(hostname -s)}"
if [ -z "$HOST" ]; then
  echo "ERROR: CANARY_HOST is unset and the short hostname is empty." >&2
  exit 2
fi

# The host goes into the URL as it is, so only plain host characters are allowed.
plain_host() {
  local LC_ALL=C
  case "$1" in
    *[!A-Za-z0-9._-]*) return 1 ;;
  esac
  return 0
}

if ! plain_host "$HOST"; then
  echo "ERROR: host '${HOST}' may hold only letters, digits, dots, dashes and underscores." >&2
  exit 2
fi

code="$(curl -sS -m 20 -o /dev/null -w '%{http_code}' \
  -X POST "${CANARY_URL}/beat?host=${HOST}" \
  -H "x-canary-secret: ${CANARY_SECRET}" 2>/dev/null)"

if [ "$code" = "200" ]; then
  exit 0
fi

echo "ERROR: beat for '${HOST}' returned HTTP ${code:-000} from ${CANARY_URL}" >&2
exit 1
