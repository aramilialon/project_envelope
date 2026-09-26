#!/usr/bin/env bash
# Protects the default branch with a repository ruleset:
# - changes reach main only through pull requests, merged with "Squash and merge";
# - the CI jobs "test" and "conventional-title" must pass before merging;
# - no force pushes and no deletion of main.
# Nobody can bypass it, the repository owner included: merging happens in the pull request.
set -euo pipefail

name="Protect main"
if gh api "repos/{owner}/{repo}/rulesets" --jq '.[].name' | grep -Fxq "$name"; then
  echo "Ruleset '$name' already exists: nothing to do."
  exit 0
fi

gh api --method POST "repos/{owner}/{repo}/rulesets" --input - <<'JSON'
{
  "name": "Protect main",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "bypass_actors": [],
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    {
      "type": "pull_request",
      "parameters": {
        "required_approving_review_count": 0,
        "dismiss_stale_reviews_on_push": false,
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "required_review_thread_resolution": false,
        "allowed_merge_methods": ["squash"]
      }
    },
    {
      "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": false,
        "required_status_checks": [{ "context": "test" }, { "context": "conventional-title" }]
      }
    }
  ]
}
JSON
echo "Ruleset '$name' created."
