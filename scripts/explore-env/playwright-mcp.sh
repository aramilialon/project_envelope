#!/bin/sh
# Starts the Playwright MCP server for the `explorer` agent (.claude/agents/explorer.md), confined:
# - its working directory is a fresh temporary directory, and --ignore-roots stops it from using the
#   client's workspace roots, so every file its tools write (snapshots, screenshots, evaluate results)
#   lands there and never in the repository;
# - --allowed-origins keeps ordinary navigation and requests on loopback (not a hard boundary:
#   redirects and service workers can bypass it);
# - --isolated keeps the browser profile in memory; file:// navigation is blocked by default.
# The pinned version is a devDependency of @envelope/scripts; install its browser once with
#   pnpm --filter @envelope/scripts exec playwright-mcp install-browser chrome-for-testing
set -eu
bin="$(cd "$(dirname "$0")/.." && pwd)/node_modules/.bin/playwright-mcp"
work="$(mktemp -d -t envelope-explorer.XXXXXX)"
chmod 700 "$work"
cd "$work"
exec "$bin" --headless --isolated --browser chromium --ignore-roots \
  --output-dir "$work/out" --file-paths absolute \
  --allowed-origins 'http://127.0.0.1:*;http://localhost:*' --no-webmcp \
  --redact-url-params code,session_state,access_token
