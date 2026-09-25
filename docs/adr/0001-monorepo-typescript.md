# 0001 — TypeScript monorepo with pnpm

- **Status:** accepted
- **Date:** 2026-09-25

## Context

envelope will have a server, a web app and a mobile app that must apply the same budgeting and rebalancing rules. The main developer comes from Perl and bash and is learning modern web development.

## Decision

- One repository (monorepo) with several packages: `packages/*` for shared libraries, `apps/*` for applications.
- TypeScript everywhere, run by Node.js 24.
- pnpm as the package manager, with its version pinned in the `packageManager` field.
- Strict TypeScript options (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`) and `erasableSyntaxOnly`: the code can be run directly by Node.js, which strips the types without a build step.
- Turborepo will be added when there are several packages to build; today `pnpm -r` commands are enough.

## Consequences

- One language to learn for the whole project.
- Domain logic in `packages/core` is shared without duplication.
- Strict options report more errors early on, but prevent bugs in financial data.
