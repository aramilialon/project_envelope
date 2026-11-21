# 0017 — API rate limits in process, per client address and per verified user

- **Status:** accepted
- **Date:** 2026-11-21
- **Refines:** D15 of [ADR 0014](0014-assistant-access-through-mcp.md) ("Rate limits in two layers"), for the API. ADR 0014 stands.

## Context

The design document ("API protection") asks for rate limits, and ADR 0014 (D15) asks for in-process limits in the API and the MCP server, with connection limits at the edge, before either is reachable from outside the local network. Until #566 the API had none: any client could send requests as fast as it liked, the health check (which queries the database) and requests with a bad token (which run the token verifier) included. Code scanning reported both: route handlers that access the database or perform authorization without a rate limit.

## Decision

- **In process, with `@fastify/rate-limit` and its in-memory store.** The limits live in the API's own code, where they are tested with the rest of it and visible to code scanning. Each of the four limiters (per address, and per user for all requests, writes and imports) has its own store, an LRU of at most 10 000 keys passed to each limiter: the plugin's root `cache` option sizes only its global limit, which the API does not use, and would leave every limiter at the plugin's default of 5000.
- **Two keys, in two places.**
  - **Per client address**, on `onRequest`, before anything else runs. Every route counts, so a flood of requests with a bad or missing token, or of 404s, is refused before it reaches the token verifier or a route.
  - **Per user**, as a preHandler right after the user mapper, keyed on the local user id of the token the API has just verified. It counts every request of the user, whichever address it comes from, so one member of a household never uses up another's allowance. A stricter limit applies to writes (`POST`, `PUT`, `PATCH`, `DELETE`), and a stricter one still to file imports, the most expensive request. A request without a valid token is answered 401 before this layer, never 429 from a user's count.
- **CORS preflights are answered before the limit.** `@fastify/cors` answers an `OPTIONS` preflight in its own `onRequest` hook, which runs before the per-address one, so a preflight is never counted and is answered even for an address over its limit; the request it precedes is counted as usual. The CORS policy exposes `Retry-After`, which is not a safelisted response header, so the web app can read it from a 429.
- **Sign-in is not limited here.** The API has no sign-in route: users sign in at Keycloak, whose own brute-force detection limits failed attempts. The API only verifies the tokens Keycloak issues, and a request with a bad token counts against its address like any other.
- **The health check is limited, not exempt.** It queries the database, so it stays under the per-address limit; a monitor calls it far less often than the limit allows.
- **The client address.** Fastify's `trustProxy` lists only the configured reverse proxies (`TRUST_PROXY`, empty by default; `127.0.0.1` behind Caddy on the same machine, which replaces any `X-Forwarded-For` a client sends with the address it sees). From any other address, `X-Forwarded-For` is ignored, so a client cannot choose the address it is counted under. `true` (trust everyone) is refused at startup. An IPv6 address counts by its /64. Behind Caddy, `TRUST_PROXY` must be set: otherwise every request reaches the API from Caddy's own address, and the whole household shares one per-address count.
- **The reply.** A request over a limit is answered 429 with the stable code `too_many_requests`, `details.retryAfterSeconds`, and `Retry-After`, through the global error handler like every other error. The web app translates the code.
- **Configured by environment**, with defaults sized for a household and set in one place (`RATE_LIMIT_DEFAULTS` in `apps/api/src/config.ts`; `apps/api/README.md`, "Configuration"): 1200 requests a minute per user, 2400 per address, 120 writes a minute per user, 10 file imports a minute per user. An ordinary session in the web app with a 35-category budget was measured at about 325 requests in 7 seconds, so the per-user limit leaves room for a few such bursts in one minute; writes and imports are far rarer and keep stricter limits.
- **The per-address limit is above the per-user one.** One address can carry several members: every device of a household behind one NAT, or all of them under Caddy's address when `TRUST_PROXY` is missing. The per-address limit runs first, so if it were lower it would refuse a member before the per-user limit, which is the one meant to keep members apart, ever applied. It is there to stop floods before authentication, not to share out a household's allowance.
- **Connection limits at the edge** (concurrent connections, slow clients) stay with the relay setup that makes the API reachable from outside (milestone 0.4.x), as ADR 0014 planned.
- **The dependency.** `@fastify/rate-limit` is pinned at 11.2.2. Advisory GHSA-24mh-2vvh-5r45 does not apply: it concerns reading a count with `increment: false`, which this API never does (every check counts the request). The bump to 11.3.0 follows in its own change.

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
