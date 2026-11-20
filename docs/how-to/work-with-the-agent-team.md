# Work with the agent team

Besides the maintainer, work on `envelope` uses a small team of AI agents, each with one role. Their definitions are in [`.claude/agents/`](../../.claude/agents/). The main session acts as **coordinator**: it prepares the work, calls each role at the right moment, and brings their conclusions to the maintainer. The agents recommend; **decisions stay with the maintainer**, and so do merges and releases under the rules in [Work with issues, pull requests and releases](work-with-issues-and-pull-requests.md).

## The roles

| Role | Agent | Writes code | When it works |
| --- | --- | --- | --- |
| Coordinator | the main session | only when it keeps an issue itself | throughout: briefs, branches, pull requests, merges after green CI |
| Developer | `developer` | yes, on its branch | implements one issue from a written brief |
| Architect | `architect` | no | before coding, on issues that touch schema, API, isolation, queue or sync |
| Domain expert | `domain-expert` | no | on financial rules and calculations, before and after they are built |
| UX reviewer | `ux-reviewer` | no | on a mockup before approval, and on a built screen before merge |
| QA | `qa` | no | on every branch before its pull request is merged |
| Security reviewer | `security-reviewer` | no | on changes to auth, permissions, isolation, SQL, imports or dependencies |

The automatic review workflow on GitHub (`.github/workflows/claude-code-review.yml`) adds one more independent read of every pull request.

## How an issue goes through the team

1. **Brief.** The coordinator reads the issue and writes down the acceptance criteria. Anything unclear, and any product choice, goes to the maintainer first.
2. **Design.** If the issue touches the schema, the API or isolation, the `architect` returns a plan. If it touches a financial rule, the `domain-expert` checks the rule with numeric examples. If it adds or changes a screen without an agreed mockup, a mockup is proposed in its own pull request, reviewed by the `ux-reviewer`, and approved by the maintainer.
3. **Build.** When the brief is clear (plan and mockup agreed), the `developer` builds it on its branch and reports. Exploratory issues, where the brief would cost as much as the work, stay with the coordinator.
4. **Verify.** On the finished branch: `qa` always; the `ux-reviewer` if a screen changed; the `security-reviewer` if the change matches its scope; the `domain-expert` again if a calculation was built. Reviewers run independently of each other and of the developer's report.
5. **Fix and decide.** The coordinator sends must-fix findings back to the developer, and brings to the maintainer any disagreement between roles and any finding that needs a decision.
6. **Merge.** The coordinator opens the pull request, says in its description which reviews ran and what they found, and squash-merges after green CI.

Small changes (a typo, a dependency bump with no code change, a release changelog) skip the team: the coordinator handles them directly.

## Changing the team

The definitions are ordinary Markdown files with a short header (name, description, allowed tools). Change them through a pull request like any other file. A role that keeps finding nothing useful is a candidate for removal; a kind of mistake that keeps reaching `main` is a candidate for a new check in the role that should have caught it.
