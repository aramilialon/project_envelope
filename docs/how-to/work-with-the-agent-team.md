# Work with the agent team

Besides the maintainer, work on `envelope` uses a small team of AI agents, each with one role. Their definitions are in [`.claude/agents/`](../../.claude/agents/). The main session acts as **coordinator**: it prepares the work, calls each role at the right moment, and brings their conclusions to the maintainer. The agents recommend; **decisions stay with the maintainer**, and so do merges and releases under the rules in [Work with issues, pull requests and releases](work-with-issues-and-pull-requests.md).

## The roles

| Role | Agent | Writes code | When it works |
| --- | --- | --- | --- |
| Coordinator | the main session | only when it keeps an issue itself | throughout: briefs, branches, routing findings and decisions |
| Developer | `developer` | yes, on its branch | implements one issue from a written brief |
| Architect | `architect` | no | before coding, on issues that touch schema, API, isolation, queue or sync |
| Domain expert | `domain-expert` | no | on financial rules and calculations, before and after they are built |
| UX reviewer | `ux-reviewer` | no | on a mockup before approval, and on a built screen before merge |
| QA | `qa` | no | on every branch before its pull request is merged, and to reproduce the explorers' findings |
| Security reviewer | `security-reviewer` | no | on changes to auth, permissions, isolation, SQL, imports or dependencies |
| Integrator | `integrator` | only mechanical merge resolutions | once branches have passed their reviews: orders them, brings each up to date with `main`, pushes, opens the pull request, squash-merges after green CI |
| Explorer | `explorer` | no (a browser only) | before a release, once the milestone's issues are merged: uses the app as a household, an investor or a mixed household on a disposable environment and reports reproducible findings |

The automatic review workflow on GitHub (`.github/workflows/claude-code-review.yml`) adds one independent read of every pull request, once (see "Agents and CI").

## How an issue goes through the team

1. **Brief.** The coordinator reads the issue and writes down the acceptance criteria. Anything unclear, and any product choice, goes to the maintainer first.
2. **Design.** If the issue touches the schema, the API or isolation, the `architect` returns a plan. If it touches a financial rule, the `domain-expert` checks the rule with numeric examples. If it adds or changes a screen without an agreed mockup, a mockup is proposed in its own pull request, reviewed by the `ux-reviewer`, and approved by the maintainer.
3. **Build.** When the brief is clear (plan and mockup agreed), the `developer` builds it on its branch and reports. Exploratory issues, where the brief would cost as much as the work, stay with the coordinator.
4. **Verify.** On the finished branch: `qa` always; the `ux-reviewer` if a screen changed; the `security-reviewer` if the change matches its scope; the `domain-expert` again if a calculation was built. Reviewers run independently of each other and of the developer's report.
5. **Fix and decide.** The coordinator sends must-fix findings back to the developer, and brings to the maintainer any disagreement between roles and any finding that needs a decision. When the developer's context is already very large (hundreds of thousands of tokens), the coordinator does not resume it: it starts a fresh `developer` on the same branch and worktree, with a precise brief (the findings to fix, the files involved, what must not change), since a fresh agent with a short brief works more reliably than one carrying the whole history.
6. **Integrate.** The coordinator hands the reviewed branches to the `integrator`, with each one's issue, worktree, review summary and developer. The integrator decides the order (issue dependencies, migration numbers, files several branches change), brings each branch up to date with `main` (a rebase only before the branch is first pushed, a merge of `main` afterwards; never a force-push), resolves only mechanical conflicts such as two entries added to the same changelog or list, and sends every other conflict back to the developer with the files and what changed on `main`. It then pushes, opens the pull request saying which reviews ran and what they found, waits for CI, squash-merges, and re-checks the branches still waiting, since `main` has moved.

### Working in parallel

Independent issues may run at the same time, each with its own developer, branch and worktree. Two developers never work on the same change: not on the same issue, not on the same branch, and not on two issues that change the same code at once. Dependent issues wait for the one they depend on.

## Agents and CI

Role agents run locally, on the developer machine and on disposable environments, never as new CI jobs: the maintainer's rule is to keep the overall cost, in money and tokens, as low as possible.

- The automatic AI review on GitHub (`.github/workflows/claude-code-review.yml`) gives every pull request one independent read, once, when it is opened or marked ready, not again on every push. It may read the pull request (`gh pr diff`, `gh pr view`) and the checked-out files, and post inline and summary comments; it runs no other commands and cannot change the repository.
- Dependencies are audited weekly by a token-free workflow (`.github/workflows/security-audit.yml`, `pnpm audit`) that keeps one issue open with its findings; the team fixes them locally like any other issue.
- Exploratory runs, QA and the security review stay local.

## Exploratory runs before a release

Once a milestone's issues are merged, and before its release, the coordinator runs the `explorer` on a disposable environment ([scripts/README.md](../../scripts/README.md), "Disposable environments"): one session per persona (household, investor, mixed household), each with a charter (what the release changed, the flows to cover, the odd cases to try) and a step budget, and the reference material the explorer's expectations must come from (the design document's user-interface section and mockups, and the API documentation for features with no screen yet).

- The explorer has a browser and nothing else: no shell, no source code, no credentials beyond the environment's own personas. The browser is the Playwright MCP server, a pinned devDependency of `@envelope/scripts` started by [`scripts/explore-env/playwright-mcp.sh`](../../scripts/explore-env/playwright-mcp.sh) (configured in [`.mcp.json`](../../.mcp.json)): headless, an in-memory profile, `file://` blocked, ordinary requests kept on loopback, and every file its tools write (snapshots, screenshots, script results) confined to a throwaway temporary directory, never the repository. Install its browser once with `pnpm --filter @envelope/scripts exec playwright-mcp install-browser chrome-for-testing`. The server tools nobody needs (running arbitrary code, uploading or dropping files, reading full request headers) are denied in `.claude/settings.json`.
- Keep the web app's Vite dev server stopped during a run: it serves repository files to any local page.
- The coordinator brings the environment up and down with `explore:up` and `explore:down`, and never hands the explorer the manifest file itself, only the URLs, the persona credentials and the workspace ids from it.
- Every finding must name the source of its expectation. `qa` reproduces each one on a fresh disposable environment of its own (through the API, or with an e2e spec for what only a screen shows); only reproduced findings become issues, and spec gaps and product questions go to the maintainer. Each reproduced bug is then fixed by a `developer`, from a brief like any other issue, and goes through the usual reviews; the coordinator does not fix findings itself. Every bug that gets fixed gets a deterministic test (an integration test, an e2e spec or a random-walk seed): explorer runs never gate a merge.

## Keeping the team tidy

- Every agent with a shell stops its own background work before returning (the "Before you return" section of each definition): no test run, server, CI watch or disposable environment of its outlives it.
- Once a branch is merged, the coordinator stops that branch's agents (`TaskStop`) and removes its Git worktree under `.claude/worktrees/` (`git worktree remove <path>`, which keeps the branch and its history), so the list of agents and that folder show only work in progress. The folder is ignored by Git and never committed.
- The coordinator regularly compares the running agents with the reports it has received. An agent that ended without a report, or that has been waiting much longer than its task needs, is chased at once: a hang is a finding in its own right.

Small changes (a typo, a dependency bump with no code change, a release changelog) skip the team: the coordinator handles them directly.

## Changing the team

The definitions are ordinary Markdown files with a short header (name, description, allowed tools). Change them through a pull request like any other file. A role that keeps finding nothing useful is a candidate for removal; a kind of mistake that keeps reaching `main` is a candidate for a new check in the role that should have caught it.
