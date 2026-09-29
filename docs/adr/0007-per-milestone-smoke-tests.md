# 0007 — Each backend milestone gets a smoke test against the real process

- **Status:** accepted
- **Date:** 2026-09-26

## Context

Every integration test in `apps/api` (token verification, workspace membership, Row-Level Security, migrations…) runs against real dependencies: a real PostgreSQL, a real Keycloak realm provisioned through the admin API (`src/test-helpers/keycloak.ts`). None of them, however, go through a real network connection: they all call Fastify's `app.inject()`, which runs the full hook/route pipeline in-process without ever opening a TCP socket.

That leaves a gap no existing test covers: whether the actual compiled server (`src/main.ts`, what `pnpm start` runs) starts, binds its configured host/port, and answers a real HTTP request — `config.ts`'s environment parsing, `app.fastify.listen()`, and the process actually staying up are only exercised by a human running it by hand.

## Decision

- Each backend MVP milestone (`CLAUDE.md`, "Current focus") gets its own smoke test: it starts the real server as a subprocess (not `.inject()`) against its real dependencies, waits for it to report as listening, and exercises that milestone's own "done when" criterion over a real HTTP connection.
- These tests live in `apps/api/src/smoke/`, named `<milestone>.smoke.test.ts` (for example `0.1.0-api-skeleton.smoke.test.ts`). They run as part of the same `pnpm test` (`node --test`), alongside the rest of the integration tests, not as a separate command: a milestone is not done until its smoke test is green in the same CI run as everything else.
- **Most milestones are incremental**: a smoke test only proves what that milestone actually added, not a cumulative end-to-end suite (0.1.1 Schema, 0.1.2 Authentication, 0.1.4 Import, 0.1.5 Queue and notifications, 0.1.6 Sync).
- **Checkpoint milestones are comprehensive.** A milestone whose own name or "done when" is an MVP or a completed API surface — 0.1.3 Budget API, 0.1.7 Web MVP, 0.1.8 Budget MVP, and their later equivalents (a Portfolio or Mobile MVP, for example) — gets a smoke test that also re-exercises everything certified by every milestone since the last such checkpoint, not just its own addition. This is what makes 0.1.3's own "done when" (an entire budget month driven through the API alone) meaningful: accounts, categories, transactions and assignments proven to work together as a whole, not just each in isolation. 0.1.0 API skeleton is the first milestone, so nothing has accumulated yet to be comprehensive about; it stays incremental in practice even though its name also says "API".
- **A milestone with no HTTP surface of its own does not get one.** 0.1.1 Schema's "done when" (a workspace cannot read another workspace's rows) is a database-level guarantee that does not become truer by adding an HTTP hop: `src/db/schema.test.ts` (every table, RLS forced and enforced for `envelope_app`) and `src/auth/workspace-isolation.test.ts` (the same proof through a real `envelope_app` connection and a real request) already certify it as an ensemble. The convention starts in practice with 0.1.0 (a real `GET /health` over the network) and 0.1.2 (a real authenticated request, `GET /me`, over the network).
- **Positive and negative, random where the surface is numeric.** A smoke test covers both a case that must succeed and one that must correctly fail. Where the logic is numeric (a balance invariant, a computed amount), the data is generated with a fixed-seed pseudo-random generator (`mulberry32`, the same one `packages/core`'s own invariant tests use) instead of hand-picked values, and the expected result is computed from that same generated data, never copied from a previous run's output — so a test cannot pass by coincidence, confirming the same mistake the implementation made. Where the surface is boolean (a route exists or not, a token is valid or not), one well-chosen case per side is enough: randomizing it would not add any more assurance.

## Consequences

- A milestone's smoke test starts and stops a real subprocess, so it is slower than the rest of the suite; this is accepted as the cost of proving the process itself works, not just its handlers.
- A checkpoint milestone's smoke test grows over time and takes longer to run than an incremental one; accepted as the cost of proving the accumulated surface still works as a whole at a real release boundary, not just at each incremental step.
- A route added only to give a milestone something real to smoke-test (`GET /me`, 0.1.2) must say so where it is defined, and stay out of production if it is not itself a committed product feature yet.
- Future milestones add their own `apps/api/src/smoke/<milestone>.smoke.test.ts` as part of finishing that milestone, not as separate follow-up work.
