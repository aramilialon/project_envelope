# Work with issues, pull requests and releases

Every change reaches `main` through a pull request. Claude Code, like any contributor, pushes branches and opens pull requests, and never pushes to `main`. It may review and approve pull requests (`gh pr review`) and squash-merge them, but only after the CI run on the pull request has passed; the maintainer can review any pull request before or after.

## How the pieces fit together

| Piece | Role | Example |
| --- | --- | --- |
| Milestone | A goal with a version number and a "done when" criterion | `0.1.0 API skeleton` |
| Issue | One task inside a milestone, with labels | "Migration runner with checksums" |
| Branch | The work on one issue | `feat/12-migration-runner` |
| Pull request | The proposal to merge the branch into `main`; closes the issue when merged | "Add the migration runner", body `Closes #12` |
| Release | A tag and release notes when a milestone is complete | `v0.1.0` |

## One-time setup

1. Install and authenticate the GitHub CLI (the Ansible playbook installs it with the `github` tag):
   ```bash
   gh auth login        # GitHub.com → SSH → use the existing key → log in with a browser
   ```
2. Create labels and milestones:
   ```bash
   scripts/github/bootstrap.sh
   ```
3. Protect `main` on GitHub (pull requests only, squash merge only, CI and the commit-convention check must pass, no force push):
   ```bash
   scripts/github/protect-main.sh
   ```
4. Activate the Git hooks in each clone (they refuse pushes to `main` and check commit messages):
   ```bash
   git config core.hooksPath scripts/git-hooks
   ```
5. Every new issue is added to the [project board](https://github.com/users/aramilialon/projects/3) automatically (`.github/workflows/add-to-project.yml`); pull requests are not, since a pull request that closes an issue already on the board would just duplicate its card. It needs a token with `project` scope that the repository's own `GITHUB_TOKEN` does not have (the board belongs to the user, not the repository): create a fine-grained personal access token with read/write access to Projects, then store it once:
   ```bash
   gh secret set PROJECT_BOARD_TOKEN
   ```

## The workflow

1. **Pick or create an issue** in the current milestone:
   ```bash
   gh issue create --title "Migration runner with checksums" --label area:api --label type:feature --milestone "0.1.0 API skeleton"
   ```
2. **Create a branch** from an up-to-date `main`, named `<type>/<issue>-<short-description>`:
   ```bash
   git switch main && git pull
   git switch -c feat/12-migration-runner
   ```
   Branch types: `feat`, `fix`, `chore`, `docs`.
3. **Commit** following the commit convention (below), referencing the issue:
   ```text
   feat(api): add the migration runner

   Applies pending SQL files in order, one transaction each, and records
   their checksums in schema_migrations.

   Refs #12
   ```
4. **Push the branch and open the pull request**:
   ```bash
   git push -u origin feat/12-migration-runner
   gh pr create --fill --milestone "0.1.0 API skeleton"
   ```
   The title must follow the commit convention too, for example `feat(api): add the migration runner`: it becomes the commit message on `main`. The template asks for `Closes #12`, the tests run and the checklist.
5. **Review and merge (a person).** Read the changes on GitHub, wait for a green CI, then merge with **Squash and merge**: `main` gets one commit per pull request, and the issue closes automatically.

   A pull request whose changed files are all Markdown (anywhere, including `.claude/agents/`) or under `docs/` (mockups, screenshots, ADRs) skips CI's `unit`, `integration` and `e2e` jobs: they show as skipped, and the pull request can be merged once the remaining checks pass. The decision comes from the files, not from the title, so a `docs:` pull request that also touches code still runs everything.
6. **Clean up**:
   ```bash
   git switch main && git pull
   git branch -d feat/12-migration-runner
   ```

## Commit convention

The first line of every commit message, and every pull request title, looks like `<type>(<scope>): <description>`:

| Type | When |
| --- | --- |
| `feat` | New functionality |
| `fix` | A bug fix |
| `docs` | Documentation only |
| `refactor` | Code change that neither adds a feature nor fixes a bug |
| `test` | Tests only |
| `perf` | Faster or lighter, same behavior |
| `build` | Dependencies, build configuration |
| `ci` | CI workflows |
| `chore` | Maintenance that fits nothing above |
| `revert` | Undoes a previous commit |

- **Scope** (optional): the part of the project, one of `core`, `api`, `web`, `mobile`, `infra`, `deps`.
- **Description**: imperative mood, lower case, no final period: "add", not "added" or "adds".
- **Breaking change**: add `!` before the colon, as in `feat(api)!: rename the budget endpoint`, and explain it in the body.

Examples:

```text
feat(core): support credit card payment categories
fix(api): reject transactions dated in an invalid month
docs: explain the release process
build(deps): update pnpm to 10.34.5
```

The `commit-msg` hook in `scripts/git-hooks` rejects other formats, and the "PR title" workflow checks pull request titles. The types also tell which version number to raise at release time: `feat` raises the minor version, `fix` the patch version, a `!` the major version (from 1.0.0 onwards).

## Releasing a milestone

When every issue of a milestone is closed:

1. Hold the exploratory run ([Work with the agent team](work-with-the-agent-team.md#exploratory-runs-before-a-release)): all three explorers use the app on a disposable environment, each on its own charter plus what the release changed; the coordinator merges duplicate findings, `qa` reproduces them, the `scribe` files the reproduced ones as issues, and every reproduced bug is fixed through an issue and a pull request, or moved to a later milestone on the recommendation of the role that owns it (logged in [`docs/team/decisions.md`](../team/decisions.md)), with the maintainer's agreement when no role recommended it. This run takes the place of the maintainer's own testing before a release. When the milestone changed the install path, and before every release that closes a roadmap phase, the coordinator also holds an install run ([Work with the agent team](work-with-the-agent-team.md#install-runs)), not at the same time as the explorers, and its findings go the same way.
2. Only for a release that closes a roadmap phase (the milestones named "… MVP", such as `0.2.7 Portfolio MVP` and `0.3.2 Mobile MVP`, and `1.0.0`): the maintainer tries the app before the tag, on a disposable environment the coordinator brings up, with a short list of what the phase changed. The maintainer also reviews the section of [`docs/team/decisions.md`](../team/decisions.md) that waits for this deadline, and the coordinator then empties it through a pull request whose description gives each entry's outcome (confirmed; confirmed and moved into an ADR or the design text, named; or reversed, with the new issue that reverses it). What the maintainer finds goes through the same issues and pull requests. Every other release is tagged without the maintainer's testing.
3. Check the repository's open security alerts and deal with every one before going on:
   ```bash
   gh api "repos/:owner/:repo/dependabot/alerts?state=open" -q 'length'
   gh api "repos/:owner/:repo/code-scanning/alerts?state=open" -q '.[] | "\(.number) \(.rule.id) \(.most_recent_instance.location.path)"'
   gh api "repos/:owner/:repo/secret-scanning/alerts?state=open" -q 'length'
   ```
   Each alert is either fixed through an issue and a pull request like any other bug, or, when it is a false positive or does not apply to how the app is deployed, dismissed on GitHub with that reason written in the dismissal comment. A secret-scanning alert also means rotating the secret, not only removing it from the code. The release waits until all three lists are empty.

Once steps 1 to 3 have passed, the coordinator gives the `integrator` the go, with the team-memory notes still staged, the list of lessons to prune (those nobody hit in the last two milestones), and the `product-marketer`'s agreed wording for the release's changelog section, which the integrator applies to the compiled section in the step 4 pull request ([Work with the agent team](work-with-the-agent-team.md#product-and-public-material)), without asking the maintainer first (the maintainer's decision; for a phase release, only after step 2), and the integrator runs steps 4 to 6.

4. Compile the changelog fragments into a new section `## [0.1.0] - YYYY-MM-DD` of `CHANGELOG.md`, through a small pull request: on a branch from `origin/main`, run `pnpm --filter @envelope/scripts changelog:release 0.1.0` (today's date in UTC, or `--date YYYY-MM-DD`). It writes the fragments in `changes/unreleased/`, and any entry a branch still wrote under **Unreleased**, into the new section grouped by Added, Changed, Fixed and Removed, deletes the fragments and leaves **Unreleased** empty; commit `CHANGELOG.md` and the deleted files together (`git add CHANGELOG.md changes/unreleased`). It refuses a malformed fragment, a version already in the changelog and an empty release, and then changes nothing. The same pull request is the release changelog and its team-memory flush: it adds the staged notes the coordinator handed over into [`docs/team/`](../team/), and deletes the lessons on the coordinator's list to prune ([Work with the agent team](work-with-the-agent-team.md#team-memory)).
5. After merging it, the integrator tags it and publishes the release. `main` stays checked out in the primary worktree, so the integrator does not switch to it: it fetches, checks that `origin/main` is the merged changelog commit (`git log -1 --oneline origin/main`), and tags that commit:
   ```bash
   git fetch origin
   git log -1 --oneline origin/main
   git tag -a v0.1.0 origin/main -m "v0.1.0 API skeleton"
   git push origin v0.1.0
   gh release create v0.1.0 --title "v0.1.0 API skeleton" --generate-notes
   ```
6. Close the milestone on GitHub.

## Safeguards against direct pushes

| Layer | What it does | Limit |
| --- | --- | --- |
| Ruleset on GitHub (`protect-main.sh`) | Rejects any push to `main` that is not a merged pull request, only "Squash and merge" allowed, requires the `test` and `conventional-title` checks | The repository is public, so this works on the free plan |
| Git hooks (`scripts/git-hooks/`) | `pre-push` refuses `git push` to `main`; `commit-msg` checks the commit convention | Local: must be activated in each clone |
| Claude Code rules (`.claude/settings.json`) | Deny pushing to `main`, force pushes and skipping hooks; allow squash merges, pull request reviews, raw API calls (`gh api`) and reading releases (`gh release view`, `gh release list`); allow creating a `v*` tag, pushing it and creating its release; ask before deleting or moving a tag and before editing or deleting a release | Match the usual command forms, not every possible variant |

Only the ruleset is a real boundary; the other two catch mistakes early.
