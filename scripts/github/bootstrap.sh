#!/usr/bin/env bash
# Creates the labels and milestones used to plan envelope on GitHub.
# Safe to run again: existing labels are updated, existing milestones are kept.
#
# Requirements: the GitHub CLI (gh), authenticated with `gh auth login`,
# run from inside a clone of the repository.
set -euo pipefail

command -v gh >/dev/null || { echo "gh is not installed" >&2; exit 1; }
gh auth status >/dev/null || { echo "run 'gh auth login' first" >&2; exit 1; }

echo "== Labels"
# name|color|description
labels=(
  "area:core|1d76db|Domain logic in packages/core"
  "area:api|0e8a16|Server in apps/api"
  "area:web|5319e7|Web app in apps/web"
  "area:mobile|b60205|Mobile app in apps/mobile"
  "area:infra|c5def5|Docker, Ansible, CI"
  "area:docs|fef2c0|Documentation"
  "type:feature|a2eeef|New functionality"
  "type:bug|d73a4a|Something does not work"
  "type:chore|ededed|Maintenance, tooling, dependencies"
  "type:docs|0075ca|Documentation only"
)
for entry in "${labels[@]}"; do
  IFS='|' read -r name color description <<<"$entry"
  gh label create "$name" --color "$color" --description "$description" --force >/dev/null
  echo "  $name"
done

echo "== Milestones"
# title|description (the description states when the milestone is done)
milestones=(
  "v0.1.0 API skeleton|Fastify server, configuration, structured logs, health endpoint, PostgreSQL connection, migration runner, integration tests against PostgreSQL in CI. Done when the API starts, migrates an empty database and CI is green."
  "v0.2.0 Schema|Users, workspaces, memberships, accounts, categories and groups, transactions with splits and transfers, monthly assignments, Row-Level Security per workspace. Done when an automated test proves that a workspace cannot read another workspace's rows."
  "v0.3.0 Authentication|Keycloak access tokens verified through OpenID Connect and JWKS, user mapping, workspace roles. Done when every endpoint rejects missing or foreign tokens."
  "v0.4.0 Budget API|Accounts, categories, transactions, assignments and the budget month computed by packages/core. Done when a full budget month can be driven through the API alone."
  "v0.5.0 Import|CSV and OFX import with column mapping and duplicate detection, reconciliation with locking. Done when a real bank export imports without duplicates on a second run."
  "v0.6.0 Queue and notifications|Queue module with outbox, deduplication and processed_jobs register, push notifications for the budget. Done when the double-delivery test passes for every job type."
  "v0.7.0 Sync|Field-level change protocol with hybrid logical clocks and an offline queue. Done when two clients with offline changes converge without loss or duplicates."
  "v0.8.0 Web MVP|Budget web app with English and Italian translations. Done when a month of budgeting is possible from the browser."
  "v1.0.0 Budget MVP|A real month of a household budget managed with the app alone."
)
existing=$(gh api "repos/{owner}/{repo}/milestones?state=all&per_page=100" --jq '.[].title')
for entry in "${milestones[@]}"; do
  IFS='|' read -r title description <<<"$entry"
  if grep -Fxq "$title" <<<"$existing"; then
    echo "  $title (exists)"
  else
    gh api "repos/{owner}/{repo}/milestones" -f title="$title" -f description="$description" -f state=open >/dev/null
    echo "  $title (created)"
  fi
done
