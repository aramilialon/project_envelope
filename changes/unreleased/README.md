# Unreleased changes

Every pull request with a user-visible change adds one file here instead of editing `CHANGELOG.md`, so branches that land together never conflict over the changelog (#738). At release time the `integrator` compiles these files into `CHANGELOG.md` under the new version and deletes them (step 4 of [Releasing a milestone](../../docs/how-to/work-with-issues-and-pull-requests.md#releasing-a-milestone)).

## File name

`<issue>-<slug>.md`: the issue number, a hyphen, then a few lower-case words joined by hyphens, for example `738-changelog-fragments.md`. A pull request with changes in two sections adds two files (`738-changelog-fragments.md` and `738-changelog-fragments-fix.md`).

## Contents

```markdown
Fixed

- `apps/web`: a screen whose load fails says why instead of staying blank (`#745`).
```

- The first line is exactly one of `Added`, `Changed`, `Fixed`, `Removed`: the section of `CHANGELOG.md` the entry goes under.
- The second line is blank.
- Then one or more Markdown list items (`- `), written as in `CHANGELOG.md`: the package or app first, the issue number, what changed for the person using it. A continuation line is indented. No headings and no other text.

Within a section, the release lists the entries by issue number. `pnpm --filter @envelope/scripts changelog:check` validates the files here, and `pnpm test` does too (`scripts/lib/changelog.test.ts`), so CI refuses a malformed one.

## Entries still written under "Unreleased"

A branch started before #738 may still add its entry under `## [Unreleased]` in `CHANGELOG.md`. The release script keeps it: it puts entries found there first in their section, then the files here, and leaves the "Unreleased" heading empty. Moving such an entry into a file here is just as good, and avoids the conflict.
