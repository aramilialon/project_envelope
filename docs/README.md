# envelope documentation

| Document | Purpose |
| --- | --- |
| [Design document](design.md) | Vision, features, architecture, roadmap and decisions |
| [Getting started](getting-started.md) | Set up a Debian 13 development VM, run tests and services, publish to GitHub |
| [How-to guides](how-to/) | Step-by-step recipes for changing the project |
| [Decisions (ADR)](adr/) | Why a solution was chosen, and which alternatives were discarded |
| [Glossary](glossary.md) | Financial and technical terms used in the code |
| [Mockups](ux/mockups/) | Interactive mockups of the interface, open them in a browser; described in the design document's "User interface" section |

## How-to guides

- [Add a test to the core](how-to/add-a-core-test.md)
- [Work with issues, pull requests and releases](how-to/work-with-issues-and-pull-requests.md)

## Decisions

| No. | Decision |
| --- | --- |
| [0001](adr/0001-monorepo-typescript.md) | TypeScript monorepo with pnpm |
| [0002](adr/0002-amounts-in-minor-units.md) | Amounts as integer minor units |
| [0003](adr/0003-core-tests-with-node-test.md) | Core tests with `node:test`, no dependencies |
| [0004](adr/0004-internationalization.md) | English source, translatable UI, locale-aware formatting |
| [0005](adr/0005-plain-sql-and-node-postgres.md) | Plain SQL migrations and node-postgres |

## Rule

Every code change updates the documentation it affects. If a how-to guide is not enough to make a change on your own, fix the guide.
