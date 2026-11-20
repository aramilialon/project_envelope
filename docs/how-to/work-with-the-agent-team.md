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
| QA | `qa` | no | on every branch before its pull request is merged |
| Security reviewer | `security-reviewer` | no | on changes to auth, permissions, isolation, SQL, imports or dependencies |
| Integrator | `integrator` | only mechanical merge resolutions | once branches have passed their reviews: orders them, brings each up to date with `main`, pushes, opens the pull request, squash-merges after green CI |
| Explorer | `explorer` | no (a browser only) | before a release, once the milestone's issues are merged: uses the app as a household, an investor or a mixed household on a disposable environment and reports reproducible findings |

The automatic review workflow on GitHub (`.github/workflows/claude-code-review.yml`) adds one more independent read of every pull request.

## How an issue goes through the team

1. **Brief.** The coordinator reads the issue and writes down the acceptance criteria. Anything unclear, and any product choice, goes to the maintainer first.
2. **Design.** If the issue touches the schema, the API or isolation, the `architect` returns a plan. If it touches a financial rule, the `domain-expert` checks the rule with numeric examples. If it adds or changes a screen without an agreed mockup, a mockup is proposed in its own pull request, reviewed by the `ux-reviewer`, and approved by the maintainer.
3. **Build.** When the brief is clear (plan and mockup agreed), the `developer` builds it on its branch and reports. Exploratory issues, where the brief would cost as much as the work, stay with the coordinator.
4. **Verify.** On the finished branch: `qa` always; the `ux-reviewer` if a screen changed; the `security-reviewer` if the change matches its scope; the `domain-expert` again if a calculation was built. Reviewers run independently of each other and of the developer's report.
5. **Fix and decide.** The coordinator sends must-fix findings back to the developer, and brings to the maintainer any disagreement between roles and any finding that needs a decision.
6. **Integrate.** The coordinator hands the reviewed branches to the `integrator`, with each one's issue, worktree, review summary and developer. The integrator decides the order (issue dependencies, migration numbers, files several branches change), brings each branch up to date with `main` (a rebase only before the branch is first pushed, a merge of `main` afterwards; never a force-push), resolves only mechanical conflicts such as two entries added to the same changelog or list, and sends every other conflict back to the developer with the files and what changed on `main`. It then pushes, opens the pull request saying which reviews ran and what they found, waits for CI, squash-merges, and re-checks the branches still waiting, since `main` has moved.

## Exploratory runs before a release

Once a milestone's issues are merged, and before its release, the coordinator runs the `explorer` on a disposable environment ([scripts/README.md](../../scripts/README.md), "Disposable environments"): one session per persona (household, investor, mixed household), each with a charter (what the release changed, the flows to cover, the odd cases to try) and a step budget, and the reference material the explorer's expectations must come from (the design document's user-interface section and mockups, and the API documentation for features with no screen yet).

- The explorer has a browser and nothing else: no shell, no files, no source code, no credentials beyond the environment's own personas. The browser is the Playwright MCP server configured in [`.mcp.json`](../../.mcp.json) (headless, an in-memory profile, `file://` blocked).
- The coordinator brings the environment up and down with `explore:up` and `explore:down`, and never hands the explorer the manifest file itself, only the URLs, the persona credentials and the workspace ids from it.
- Every finding must name the source of its expectation. The coordinator (or `qa`) reproduces each one on a fresh environment; only reproduced findings become issues, and spec gaps and product questions go to the maintainer. Every bug that gets fixed gets a deterministic test (an integration test, an e2e spec or a random-walk seed): explorer runs never gate a merge.

Small changes (a typo, a dependency bump with no code change, a release changelog) skip the team: the coordinator handles them directly.

## Changing the team

The definitions are ordinary Markdown files with a short header (name, description, allowed tools). Change them through a pull request like any other file. A role that keeps finding nothing useful is a candidate for removal; a kind of mistake that keeps reaching `main` is a candidate for a new check in the role that should have caught it.
