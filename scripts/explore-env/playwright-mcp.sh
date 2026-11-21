#!/bin/sh
# Starts one explorer's Playwright MCP server (.mcp.json: playwright-household, playwright-investor,
# playwright-mixed), the browser of the matching agent .claude/agents/explorer-<persona>.md. Usage:
#   playwright-mcp.sh <household|investor|mixed>
# Every server is its own process with its own browser, so the explorers can run at the same time
# without sharing tabs, and one closing its browser leaves the others alone. Each is confined alike:
# - its working directory is a fresh temporary directory, and --ignore-roots stops it from using the
#   client's workspace roots, so every file its tools write (snapshots, screenshots, evaluate results)
#   lands there and never in the repository;
# - --allowed-origins keeps ordinary navigation and requests on loopback (not a hard boundary:
#   redirects and service workers can bypass it);
# - --isolated keeps the browser profile in memory: no user data directory on disk, nothing shared
#   between servers; file:// navigation is blocked by default;
# - no --port: it speaks MCP over stdio only and listens on no port.
# The pinned version is a devDependency of @envelope/scripts; install its browser once with
#   pnpm --filter @envelope/scripts exec playwright-mcp install-browser chrome-for-testing
set -eu
case "${1:-}" in
  household | investor | mixed) persona="$1" ;;
  *) echo "usage: $0 <household|investor|mixed>" >&2; exit 64 ;;
esac
bin="$(cd "$(dirname "$0")/.." && pwd)/node_modules/.bin/playwright-mcp"
work="$(mktemp -d -t "envelope-explorer-$persona.XXXXXX")"
chmod 700 "$work"
cd "$work"
exec "$bin" --headless --isolated --browser chromium --ignore-roots \
  --output-dir "$work/out" --file-paths absolute \
  --allowed-origins 'http://127.0.0.1:*;http://localhost:*' --no-webmcp \
  --redact-url-params code,session_state,access_token
