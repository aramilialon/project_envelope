# 0017 — API rate limits in process, per client address and per verified user

- **Status:** accepted
- **Date:** 2026-11-21
- **Refines:** D15 of [ADR 0014](0014-assistant-access-through-mcp.md) ("Rate limits in two layers"), for the API. ADR 0014 stands.

## Context

The design document ("API protection") asks for rate limits, and ADR 0014 (D15) asks for in-process limits in the API and the MCP server, with connection limits at the edge, before either is reachable from outside the local network. Until #566 the API had none: any client could send requests as fast as it liked, the health check (which queries the database) and requests with a bad token (which run the token verifier) included. Code scanning reported both: route handlers that access the database or perform authorization without a rate limit.

## Decision

- **In process, with `@fastify/rate-limit` and its in-memory store.** The limits live in the API's own code, where they are tested with the rest of it and visible to code scanning.
- **Two keys, in two places.**
  - **Per client address**, on `onRequest`, before anything else runs. Every route counts, so a flood of requests with a bad or missing token, or of 404s, is refused before it reaches the token verifier or a route.
  - **Per user**, as a preHandler right after the user mapper, keyed on the local user id of the token the API has just verified. It counts every request of the user, whichever address it comes from, so one member of a household never uses up another's allowance. A stricter limit applies to writes (`POST`, `PUT`, `PATCH`, `DELETE`), and a stricter one still to file imports, the most expensive request. A request without a valid token is answered 401 before this layer, never 429 from a user's count.
- **The health check is limited, not exempt.** It queries the database, so it stays under the per-address limit; a monitor calls it far less often than the limit allows.
- **The client address.** Fastify's `trustProxy` lists only the configured reverse proxies (`TRUST_PROXY`, empty by default; `127.0.0.1` behind Caddy on the same machine, which replaces any `X-Forwarded-For` a client sends with the address it sees). From any other address, `X-Forwarded-For` is ignored, so a client cannot choose the address it is counted under. `true` (trust everyone) is refused at startup. An IPv6 address counts by its /64.
- **The reply.** A request over a limit is answered 429 with the stable code `too_many_requests`, `details.retryAfterSeconds`, and `Retry-After`, through the global error handler like every other error. The web app translates the code.
- **Configured by environment**, with defaults sized for a household: 300 requests a minute per address, 600 per user, 120 writes a minute per user, 10 file imports a minute per user (`apps/api/README.md`, "Configuration").
- **Connection limits at the edge** (concurrent connections, slow clients) stay with the relay setup that makes the API reachable from outside (milestone 0.4.x), as ADR 0014 planned.

## Alternatives considered

- **Limits in Caddy.** Caddy has no rate limiting of its own; it needs a third-party module and so a custom build of Caddy to maintain, and the limits would be invisible to the API's tests and to code scanning. It could not key on the verified user either.
- **A shared store (Redis).** It survives restarts and serves several API processes, but adds a service to run, secure and back up for a deployment that runs one API process.
- **Keying the per-user limit on a claim of an unverified token.** It would let the per-user limit run before verification, but a client could put any user's id in a forged token and use up that user's allowance. The per-address limit already covers requests before verification.

## Consequences

- The counters reset when the API restarts; a restart therefore gives a client a fresh allowance.
- Running more than one API process would give each its own counters; scaling out needs a shared store first.
- Behind a proxy, `TRUST_PROXY` must name it, or every client is counted as the proxy's one address; the getting-started guide says so where Caddy is set up.
- The sync protocol and the MCP server may need limits of their own per route once their traffic is known; the plugin supports per-route limits.
- Tests build apps with limits far above what they send; one test file and one smoke case test the limits themselves.
