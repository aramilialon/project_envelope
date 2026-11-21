# Work with the agent team

Besides the maintainer, work on `envelope` uses a small team of AI agents, each with one role. Their definitions are in [`.claude/agents/`](../../.claude/agents/). The main session acts as **coordinator**: it prepares the work, calls each role at the right moment, and brings their conclusions to the maintainer. The agents recommend; **decisions stay with the maintainer**, and so do merges and releases under the rules in [Work with issues, pull requests and releases](work-with-issues-and-pull-requests.md).

## The roles

| Role | Agent | Writes code | When it works |
| --- | --- | --- | --- |
| Coordinator | the main session | only when it keeps an issue itself | throughout: briefs, branches, routing findings and decisions |
| Developer | `developer` | yes, on its branch | implements one issue from a written brief |
| Translator | `translator` | only the translated catalogs (and new glossary terms), on the developer's branch | after the developer, before the reviews, when the branch changes `packages/i18n/locales/en.json` |
| Architect | `architect` | no | before coding, on issues that touch schema, API, isolation, queue or sync |
| Domain expert | `domain-expert` | no | on financial rules and calculations, before and after they are built |
| UX reviewer | `ux-reviewer` | no | on a mockup before approval, and on a built screen before merge |
| QA | `qa` | no (throwaway reproduction specs only, never committed) | on every branch before its pull request is merged, and to reproduce the explorers' findings |
| Security reviewer | `security-reviewer` | no | on changes to auth, permissions, isolation, SQL, imports or dependencies |
| Integrator | `integrator` | only mechanical merge resolutions | once branches have passed their reviews: orders them, brings each up to date with `main`, pushes, opens the pull request, squash-merges after green CI |
| Explorer | `explorer-household`, `explorer-investor`, `explorer-mixed` | no (a browser of its own only) | before a release, once the milestone's issues are merged: uses the app as a household, an investor or a mixed household on a disposable environment and reports reproducible findings |

The automatic review workflow on GitHub (`.github/workflows/claude-code-review.yml`) adds one independent read of every pull request, once (see "Agents and CI").

## How an issue goes through the team

1. **Brief.** The coordinator reads the issue and writes down the acceptance criteria. Anything unclear, and any product choice, goes to the maintainer first.
2. **Design.** If the issue touches the schema, the API or isolation, the `architect` returns a plan. If it touches a financial rule, the `domain-expert` checks the rule with numeric examples. If it adds or changes a screen without an agreed mockup, a mockup is proposed in its own pull request, reviewed by the `ux-reviewer`, and approved by the maintainer.
3. **Build.** When the brief is clear (plan and mockup agreed), the `developer` builds it on its branch and reports. Exploratory issues, where the brief would cost as much as the work, stay with the coordinator.
4. **Translate.** If the branch changes interface text, the developer has written it in English only and regenerated `packages/i18n/locales/en.json` ([ADR 0015](../adr/0015-english-first-translations.md)). The coordinator then runs the `translator` on the same branch and worktree, once the developer has reported: it writes Italian, German, Spanish and French, following `packages/i18n/glossary.md`, and leaves `pnpm --filter @envelope/i18n check` green. See "Translations" below.
5. **Verify.** On the finished, translated branch: `qa` always; the `ux-reviewer` if a screen changed; the `security-reviewer` if the change matches its scope; the `domain-expert` again if a calculation was built. Reviewers run independently of each other and of the developer's report, so `qa` and the `ux-reviewer` run in parallel.
6. **Fix and decide.** The coordinator sends must-fix findings back to the developer, and brings to the maintainer any disagreement between roles and any finding that needs a decision. When the developer's context is already very large (hundreds of thousands of tokens), the coordinator does not resume it: it starts a fresh `developer` on the same branch and worktree, with a precise brief (the findings to fix, the files involved, what must not change), since a fresh agent with a short brief works more reliably than one carrying the whole history. A fix that changes interface text goes through the `translator` again before the reviews that found it look again.
7. **Integrate.** The coordinator hands the reviewed branches to the `integrator`, with each one's issue, worktree, review summary and developer. The integrator decides the order (issue dependencies, migration numbers, files several branches change), brings each branch up to date with `main` (a rebase only before the branch is first pushed, a merge of `main` afterwards; never a force-push), resolves only mechanical conflicts such as two entries added to the same changelog or list, and sends every other conflict back to the developer with the files and what changed on `main`. It then pushes, opens the pull request saying which reviews ran and what they found, waits for CI, squash-merges, and re-checks the branches still waiting, since `main` has moved. Finding out whether branches can hurt each other is the integrator's own job, not CI's. It looks at all the ready branches together, not pair by pair: besides overlapping files, it lists what each branch changes that other code uses (exported functions and types, API shapes, schema and RLS, job payloads, i18n keys, shared styles, test fixtures) and searches all the other branches for uses of it. Every branch with no such interaction goes into one batch; the integrator merges the whole batch together in a throwaway worktree and runs the full test suite there once, then opens all their pull requests at once, so their CI runs in parallel, and merges each as soon as it is green. A waiting branch is brought up to date with `main` and re-tested only when what landed meanwhile interacts with it, never just because `main` moved. Only branches that interact are integrated one at a time. A red CI run on `main` after a merge stops the merges and counts as an interaction the integrator missed.

### Translations

For an issue that changes interface text the order is: `developer` → `translator` → `ux-reviewer` and `qa` in parallel → `integrator`.

- **When the translator runs.** Only when the branch changes the English catalog: `git diff origin/main...<branch> -- packages/i18n/locales/en.json` is not empty. Otherwise (no interface text, or a screen change that reuses existing strings only) it is skipped, and the coordinator says so in the brief to the reviewers.
- **What it gets.** The issue, the branch and its worktree. It writes every key the diff adds and re-translates every key whose English text changed, in every catalog that exists; for a screen whose mockup was approved in Italian before ADR 0015, it takes the Italian from the commit recorded in `docs/ux/README.md`. It never edits code: strings joined by hand, a word order only English allows, or a formatting problem come back in its report, and the coordinator sends them to the developer (a currency rule, to the `domain-expert`), then runs the translator again on what changed.
- **Who reviews what.** Italian is read by the maintainer when reviewing the pull request; German, Spanish and French only by the agents (the translator, then the `ux-reviewer`, which looks at every language and at German on a 360 px phone). The pull request says which languages were machine-translated.
- **Branches started before ADR 0015.** Their developer was briefed to write the Italian; it keeps doing so, and the translator adds the other languages and checks the Italian against the glossary.
- **Tooling.** The [`packages/i18n` README](../../packages/i18n/README.md) describes the shipped list and review status (`locales/index.json`), extraction (`pnpm --filter @envelope/i18n extract`) and the completeness check (`pnpm --filter @envelope/i18n check`, which runs on its own, not inside `pnpm test`).
- **Adding a language** (#624–#626) follows that README's "Adding a language". The translator writes the catalog while it is not shipped yet; a `developer` on the same branch adds the loader line in `apps/web/src/i18n/catalogs.ts` and the language to `shipped` and `review` in `locales/index.json`, since the translator never edits code or the shipped list; then the `ux-reviewer` checks every screen in that language.
- **Conflicts between branches** in the catalogs are mechanical for the `integrator` (union of the keys, regenerate `en.json`, re-run the i18n check), unless both branches changed the same key.

### Working in parallel

Independent issues may run at the same time, each with its own developer, branch and worktree. Two developers never work on the same change: not on the same issue, not on the same branch, and not on two issues that change the same code at once. Dependent issues wait for the one they depend on.

## Agents and CI

Role agents run locally, on the developer machine and on disposable environments, never as new CI jobs: the maintainer's rule is to keep the overall cost, in money and tokens, as low as possible.

- The automatic AI review on GitHub (`.github/workflows/claude-code-review.yml`) gives every pull request one independent read, once, when it is opened or marked ready, not again on every push. It may read the pull request (`gh pr diff`, `gh pr view`) and the checked-out files, and post inline and summary comments; it runs no other commands and cannot change the repository.
- Dependencies are audited weekly by a token-free workflow (`.github/workflows/security-audit.yml`, `pnpm audit`) that keeps one issue open with its findings; the team fixes them locally like any other issue.
- Exploratory runs, QA and the security review stay local.

## Exploratory runs before a release

Once a milestone's issues are merged, and before its release, the coordinator runs the explorers on a disposable environment ([scripts/README.md](../../scripts/README.md), "Disposable environments"): one agent per persona, `explorer-household`, `explorer-investor` and `explorer-mixed`, each with a charter (what the release changed, the flows to cover, the odd cases to try) and a step budget, and the reference material the explorer's expectations must come from (the design document's user-interface section and mockups, and the API documentation for features with no screen yet).

- Each explorer has a browser of its own and nothing else: no shell, no source code, no credentials beyond the environment's own personas. Its browser is its own Playwright MCP server (`playwright-household`, `playwright-investor`, `playwright-mixed` in [`.mcp.json`](../../.mcp.json)), and its definition lists only that server's tools, so it cannot reach another explorer's browser. The three run at the same time without sharing tabs, so the coordinator starts them in parallel; each closes its browser with `browser_close` when it is done, which ends only its own. Every server is the pinned devDependency of `@envelope/scripts` started by [`scripts/explore-env/playwright-mcp.sh`](../../scripts/explore-env/playwright-mcp.sh) with the same confinement: headless, an in-memory profile, `file://` blocked, ordinary requests kept on loopback, no listening port, and every file its tools write (snapshots, screenshots, script results) confined to a throwaway temporary directory of its own, never the repository. Install its browser once with `pnpm --filter @envelope/scripts exec playwright-mcp install-browser chrome-for-testing`. The server tools nobody needs (running arbitrary code, uploading or dropping files, reading full request headers) are denied for every server in `.claude/settings.json`.
- The three definitions share one set of instructions, kept in [`scripts/explore-env/explorer-instructions.md`](../../scripts/explore-env/explorer-instructions.md): an explorer has no tool to read a file, so `pnpm --filter @envelope/scripts explore:agents` writes the text into each `.claude/agents/explorer-<persona>.md`. Edit the instructions (or `explorer-agents.ts` for the header and the tools), never the generated files; `pnpm test` fails when they drift apart, or when `.mcp.json` or the deny list does not match.
- Claude Code asks the maintainer to approve a project MCP server from `.mcp.json` before using it: after a change to the servers (such as the one that introduced the three browsers), approve the new ones when Claude Code asks, or with `/mcp`. `claude mcp reset-project-choices` asks again for all of them.
- Keep the web app's Vite dev server stopped during a run: it serves repository files to any local page.
- The coordinator brings the environment up and down with `explore:up` and `explore:down`, and never hands the explorer the manifest file itself, only the URLs, the persona credentials and the workspace ids from it.
- Every finding must name the source of its expectation. `qa` reproduces each one on a disposable environment of its own (`explore:up`, then `explore:down` when done): through the API with `curl`, or, for what only a screen shows, with a throwaway Playwright spec in its own scratch worktree, never committed, run against that environment with `E2E_MANIFEST`. It reports each finding as reproduced or not, with the exact steps ([`.claude/agents/qa.md`](../../.claude/agents/qa.md), "Reproducing an explorer finding"). Only reproduced findings become issues, and spec gaps and product questions go to the maintainer. Each reproduced bug is then fixed by a `developer`, from a brief like any other issue, and goes through the usual reviews; the coordinator does not fix findings itself. Every bug that gets fixed gets a deterministic test (an integration test, an e2e spec or a random-walk seed): explorer runs never gate a merge.

## Keeping the team tidy

- Every agent with a shell stops its own background work before returning (the "Before you return" section of each definition): no test run, server, CI watch or disposable environment of its outlives it.
- Once a branch is merged, the coordinator stops that branch's agents (`TaskStop`) and removes its Git worktree under `.claude/worktrees/` (`git worktree remove <path>`, which keeps the branch and its history), so the list of agents and that folder show only work in progress. The folder is ignored by Git and never committed.
- The coordinator regularly compares the running agents with the reports it has received. An agent that ended without a report, or that has been waiting much longer than its task needs, is chased at once: a hang is a finding in its own right.

Small changes (a typo, a dependency bump with no code change, a release changelog) skip the team: the coordinator handles them directly.

## Changing the team

The definitions are ordinary Markdown files with a short header (name, description, allowed tools). Change them through a pull request like any other file. A role that keeps finding nothing useful is a candidate for removal; a kind of mistake that keeps reaching `main` is a candidate for a new check in the role that should have caught it.
