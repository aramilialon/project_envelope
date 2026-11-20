#!/usr/bin/env bash
# Postgres roles are cluster-wide, not per-database. apps/api's own tests never touch the
# envelope_app/envelope_queue logins (they use login roles of their own, #585); this script only
# repairs a server whose passwords no longer match .env (for example after a test run from before
# #585, or a role recreated by hand). One command instead of retyping the ALTER ROLE pair by hand.
# It changes the passwords for every database on the server: anything logged in with the old
# ones (a dev server, an older checkout's test run) fails its next connection.
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
