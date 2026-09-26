# Work with issues, pull requests and releases

Every change reaches `main` through a pull request that a person reviews and merges. Claude Code, like any contributor, pushes branches and opens pull requests, but never pushes to `main`, never approves and never merges.

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

1. Move the entries under **Unreleased** in `CHANGELOG.md` to a new section `## [0.1.0] - YYYY-MM-DD`, through a small pull request.
2. After merging it, tag `main` and publish the release:
   ```bash
   git switch main && git pull
   git tag -a v0.1.0 -m "v0.1.0 API skeleton"
   git push origin v0.1.0
   gh release create v0.1.0 --title "v0.1.0 API skeleton" --generate-notes
   ```
3. Close the milestone on GitHub.

## Safeguards against direct pushes

| Layer | What it does | Limit |
| --- | --- | --- |
| Ruleset on GitHub (`protect-main.sh`) | Rejects any push to `main` that is not a merged pull request, only "Squash and merge" allowed, requires the `test` and `conventional-title` checks | The repository is public, so this works on the free plan |
| Git hooks (`scripts/git-hooks/`) | `pre-push` refuses `git push` to `main`; `commit-msg` checks the commit convention | Local: must be activated in each clone |
| Claude Code rules (`.claude/settings.json`) | Deny pushing to `main`, merging and approving pull requests, skipping hooks; ask before force pushes, tags, releases and raw API calls | Match the usual command forms, not every possible variant |

Only the ruleset is a real boundary; the other two catch mistakes early.
