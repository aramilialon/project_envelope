# 0007 — Each backend milestone gets a smoke test against the real process

- **Status:** accepted
- **Date:** 2026-09-26

## Context

Every integration test in `apps/api` (token verification, workspace membership, Row-Level Security, migrations…) runs against real dependencies: a real PostgreSQL, a real Keycloak realm provisioned through the admin API (`src/test-helpers/keycloak.ts`). None of them, however, go through a real network connection: they all call Fastify's `app.inject()`, which runs the full hook/route pipeline in-process without ever opening a TCP socket.

That leaves a gap no existing test covers: whether the actual compiled server (`src/main.ts`, what `pnpm start` runs) starts, binds its configured host/port, and answers a real HTTP request — `config.ts`'s environment parsing, `app.fastify.listen()`, and the process actually staying up are only exercised by a human running it by hand.

## Decision

- Each backend MVP milestone (`CLAUDE.md`, "Current focus") gets its own smoke test: it starts the real server as a subprocess (not `.inject()`) against its real dependencies, waits for it to report as listening, and exercises that milestone's own "done when" criterion over a real HTTP connection.
- These tests live in `apps/api/src/smoke/`, named `<milestone>.smoke.test.ts` (for example `0.1.0-api-skeleton.smoke.test.ts`). They run as part of the same `pnpm test` (`node --test`), alongside the rest of the integration tests, not as a separate command: a milestone is not done until its smoke test is green in the same CI run as everything else.
- A smoke test only proves what its milestone actually added; it is not a cumulative end-to-end suite. Milestone 0.1.3 (Budget API) is where a true full-scenario test (an entire budget month driven through the API alone, that milestone's own "done when") becomes possible and expected, once there is a budget to drive.
- **A milestone with no HTTP surface of its own does not get one.** 0.1.1 Schema's "done when" (a workspace cannot read another workspace's rows) is a database-level guarantee that does not become truer by adding an HTTP hop: `src/db/schema.test.ts` (every table, RLS forced and enforced for `envelope_app`) and `src/auth/workspace-isolation.test.ts` (the same proof through a real `envelope_app` connection and a real request) already certify it as an ensemble. The convention starts in practice with 0.1.0 (a real `GET /health` over the network) and 0.1.2 (a real authenticated request, `GET /me`, over the network).

## Consequences

- A milestone's smoke test starts and stops a real subprocess, so it is slower than the rest of the suite; this is accepted as the cost of proving the process itself works, not just its handlers.
- A route added only to give a milestone something real to smoke-test (`GET /me`, 0.1.2) must say so where it is defined, and stay out of production if it is not itself a committed product feature yet.
- Future milestones add their own `apps/api/src/smoke/<milestone>.smoke.test.ts` as part of finishing that milestone, not as separate follow-up work.
