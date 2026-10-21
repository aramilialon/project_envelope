#!/usr/bin/env bash
# Postgres roles are cluster-wide, not per-database: running apps/api's own test suite (even
# against envelope_test, never the dev "envelope" database) resets envelope_app's and
# envelope_queue's passwords to a fixed test-only value on the whole cluster, breaking a live
# dev server started from apps/api/.env's own passwords until they are set back. One command
# instead of retyping the ALTER ROLE pair by hand every time this happens.
#
# Reads the passwords straight out of apps/api/.env (APP_DATABASE_URL/QUEUE_DATABASE_URL), so
# there is nothing to pass on the command line; run from anywhere in the repo.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."

ENV_FILE="apps/api/.env"
[[ -f "$ENV_FILE" ]] || { echo "$ENV_FILE not found — copy apps/api/.env.example first" >&2; exit 1; }

password_of() {
  local url
  url=$(grep -m1 "^$1=" "$ENV_FILE" | cut -d= -f2-)
  [[ -n "$url" ]] || { echo "$1 not set in $ENV_FILE" >&2; exit 1; }
  # postgres://user:password@host:port/db — the password is everything between the first ":"
  # after "://" and the last "@".
  sed -E 's#^[^:]+://[^:]+:([^@]+)@.*#\1#' <<<"$url"
}

APP_PASSWORD=$(password_of APP_DATABASE_URL)
QUEUE_PASSWORD=$(password_of QUEUE_DATABASE_URL)

docker exec -i envelope-postgres-1 psql -U envelope -d envelope \
  -c "ALTER ROLE envelope_app WITH LOGIN PASSWORD '$APP_PASSWORD';" \
  -c "ALTER ROLE envelope_queue WITH LOGIN PASSWORD '$QUEUE_PASSWORD';"

echo "== envelope_app/envelope_queue passwords reset to match $ENV_FILE"
