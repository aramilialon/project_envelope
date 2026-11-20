# 0014 — Assistant access through an MCP server

- **Status:** accepted
- **Date:** 2026-11-20

## Context

Members want to ask an AI assistant about their own workspace: "how much is left in Groceries", "what did we spend on fuel this year", "how far is the portfolio from its targets". The Model Context Protocol (MCP) is the standard way to give an assistant tools that read from, and possibly write to, an application. An MCP server for `envelope` would let an assistant running on the member's own machine (over stdio) or a remote assistant (over HTTP) call those tools.

This opens a new kind of client with properties no existing client has:

- **It acts on what it reads.** An assistant follows instructions it finds in the text it is given. A payee name, a memo or an imported bank description is text an outsider can write, so a prompt-injected assistant may try to move money or leak what it read. Every write it can make, and every value it reads, must be treated with that in mind.
- **What it reads leaves the house.** Data an assistant reads is sent to the model provider. That is acceptable for a plaintext workspace whose owner allowed it, never for an end-to-end encrypted one by default (design.md, "End-to-end encryption").
- **A remote assistant needs the server on the internet.** Today every service is bound to 127.0.0.1 and only Caddy is reachable, from the LAN (`infra/Caddyfile`). A remote assistant's provider calls the MCP server from its own network, so the MCP endpoint and Keycloak's sign-in pages must become reachable from outside, with everything that follows: patching, brute-force protection, multi-factor authentication, a public certificate.
- **The app gives no advice.** The tools return what the user's own targets and thresholds require (CLAUDE.md, "No advice"); the assistant's own words are not ours and cannot be made neutral by us.

## Decisions

Numbered as in the plan the maintainer agreed, so issues can refer to them.

### Scope and switches

- **D1 — Local first.** A milestone 0.2.8 "Assistant access (local, read-only)" ships a local MCP server over stdio, read-only, before any remote access.
- **D2 — A per-workspace switch.** `workspaces.assistant_access` is `off | owner | all_members`, default `off`, and only the owner changes it. `owner` lets only the owner connect an assistant; `all_members` lets every member connect one, each with no more than their own role allows. With `off`, every delegated request to that workspace is refused, whatever connection exists.
- **D3 — Remote access is required.** Remote assistants (the hosted assistant reached through its provider's connector) can reach the workspace over the internet, secured as below, in milestone 0.4.1, after 0.4.0 has packaged the app for self-hosting.

### Sign-in and writes

- **D4 — Local sign-in kept in memory.** The local server signs in with the device authorization grant and keeps its tokens in memory only: nothing is written to disk, and a restart asks the member to sign in again.
- **D5 — Local writes confirmed per type of write.** When the local server gains writes, each type of write is confirmed by the member through MCP elicitation before it is sent to the API.
- **D5' — Remote writes are drafts only.** Over the internet, ledger moves are only drafts that a member confirms in the web app; a remote assistant never writes a transaction, an assignment or a trade directly.
- **D6 — Encrypted workspaces.** An end-to-end encrypted workspace is never reachable remotely. Locally, only if its owner explicitly opts in, after being told that the data the assistant reads is sent to the model provider (issue for milestone 0.8.0, with the encryption module).
- **D7 — Trades only as drafts.** An assistant never records a trade, locally or remotely; it can only propose a trade draft.
- **D8** is not used.

### Exposure and identity

- **D9 — How the server is exposed: a small relay host (B), decided 2026-11-20.** A virtual server forwards TLS by SNI, without terminating it, over a VPN tunnel that the home server opens outbound; Caddy receives the original client address through the PROXY protocol and applies the path and address allowlists itself (D14). No inbound port is opened at home, the home address stays out of public DNS, and TLS ends only on the home server. The sign-in pages are reachable from any address, protected by the second factor (D12) and brute-force protection; `/mcp`, the token and the discovery endpoints still accept only the provider's ranges and the LAN. The options considered were:
  - **A. Port forwarding at home.** The router forwards 443 to Caddy; a firewall allowlist admits only the provider's published address ranges (D14) and the LAN. Members sign in to Keycloak from home, through split DNS (D10), so the sign-in pages need not be reachable from anywhere else.
  - **B. A small relay host (chosen).** A virtual server forwards TLS by SNI, without terminating it, over a VPN tunnel that the home server opens outbound; Caddy receives the original client address through the PROXY protocol. No inbound port is opened at home, and TLS still ends only on the home server.

  Tunnels run by a third party that terminate TLS are rejected under both options: they would see every request and token in plaintext.
- **D10 — One public Keycloak hostname.** Keycloak gets one public hostname (`auth.<domain>`) and one issuer; on the LAN, split DNS resolves the same hostname to the home server, so tokens issued at home and outside carry the same `iss`.
- **D11 — Pre-registered clients only.** Every OAuth client is created by the administrator. Dynamic client registration is disabled and its endpoints are not published; client ID metadata documents are not supported for now.
- **D12 — Multi-factor authentication for everyone.** Once Keycloak is reachable from the internet, every user of the realm must have a second factor (one-time password or passkey).
- **D13 — Connections approved from the LAN.** The first use of a new assistant connection creates it as `pending`; a member approves it only in the web app reached from the LAN. A connection is never approved from the internet, not even by its own member.
- **D14 — IP allowlist.** `/mcp`, Keycloak's token endpoint and the discovery documents accept requests only from the provider's published ranges for MCP connectors (`160.79.104.0/21` and `153.61.208.0/20` today) and from the LAN. The ranges are kept in one place in the configuration, since they can change.
- **D15 — Rate limits in two layers.** In-process limits in the MCP server and in the API (`@fastify/rate-limit`), plus connection limits at the edge.
- **D16 — No command-line assistant away from home.** A command-line assistant on the member's laptop is supported over stdio or on the LAN, not from outside.
- **D17 — No API-level MCP connector.** The model provider's API-level MCP connector (an MCP server named in an API request) is not supported in 0.4.1.
- **D18 — One hosted client for the household.** One confidential client, `claude-hosted`, serves every member of the household; each member's connection is still separate (`assistant_connections`, below).
- **D19 — No static bearer tokens.** The MCP server never accepts a long-lived static token, whatever the client.

## Architecture

### The MCP server

- **A separate process, `apps/mcp`.** It reaches data only through the HTTP API, exactly as the web app does, and has no database credentials. Every check the API makes (membership, role, Row-Level Security, validation, reconciliation locks) therefore applies to the assistant too, with no second implementation.
- **Transports.** Stdio for the local server (0.2.8), with the public client `envelope-assistant-local` and the device authorization grant. Streamable HTTP at `https://mcp.<domain>/mcp` for remote clients (0.4.1), without the older server-sent-events transport.
- **Tools.**
  - Each tool carries MCP annotations: a title and `readOnlyHint`; the draft tools also carry `idempotentHint` and `_meta["anthropic/requiresUserInteraction"]`.
  - Results are capped at 20 KB and 50 rows, with a cursor for the next page.
  - Amounts are structured integers in minor units, and quantities and prices scaled integers (ADR 0002, ADR 0011), with a decimal string next to each for the model to read (`minorToDecimalString` in `packages/core`).
  - Text that outsiders can write (payees, memos, imported descriptions) is sanitised (`sanitizeUntrustedText`) and always returned in its own typed field, never mixed into a sentence the server writes.
  - Rebalancing is returned only as the engine's own output, introduced by "To get back to your targets:". A lint test fails on advisory wording in tool descriptions and results.
  - Explanations of a computed figure (a target, an available balance) are returned as structured steps computed in `packages/core`, not as prose.
- **Logs and alerts.** Logs record the tool name, the connection and the outcome, never the arguments or the results. Alerts go to the owner on a new connection, a request from a new address range, unusual volume and bursts of failed sign-ins.

### Remote authorization (0.4.1)

- **The MCP server is an OAuth 2.1 protected resource** (RFC 9728). Its metadata names exactly the MCP URL as `resource` and one authorization server, the realm's issuer. An unauthenticated request gets 401 with `WWW-Authenticate: Bearer resource_metadata="…", scope="envelope:read envelope:draft"`.
- **Keycloak clients.**
  - `claude-hosted`: confidential, redirect URI exactly `https://claude.ai/api/mcp/auth_callback`.
  - `claude-code`: public, a fixed `http://localhost:<port>/callback`.
  - Both: PKCE with S256, consent required (consent texts in English and Italian), full scope off, a fixed audience mapper (the MCP resource and `envelope-mcp`), no `offline_access`. Access tokens live 5 minutes; sessions expire after 7 days idle and 30 days at most; refresh tokens rotate.
- **Token checks.** The MCP server checks `aud`, `iss` and `azp` on every request.
- **Token exchange, never passthrough.** The MCP server exchanges the incoming token (RFC 8693, Keycloak 26.2 or later) through its own confidential client `envelope-mcp`, authenticated with `private_key_jwt`, for a reduced-scope token whose audience is the API. It never forwards the token it received. It sends the original `azp` in a header that the API trusts only on tokens issued to `envelope-mcp`.
- **Keycloak for the internet.** Upgraded to the current 26.x and run in production mode with `--hostname=https://auth.<domain>`. The admin console is reachable from the LAN only. Brute-force protection and a password policy are on, and every user has a second factor (D12). Caddy publishes only an allowlist of paths: `openid-connect/auth`, `login-actions/*`, `resources/*`, the token endpoint and discovery, plus root-level discovery rewrites. The admin console, the master realm, the account console and client registration answer 404. The certificate comes from ACME. Request bodies to `/mcp` are limited to 64 KB, and requests with an unexpected `Origin` are refused.

### The API

- **Delegated tokens.** A token whose `azp` is not one of the app's own clients is a delegated token. Delegated requests are denied by default. Each route allowed to them carries a flag, `assistant: read` or, on the two draft routes, `assistant: draft`. Routes that confirm a draft can never be flagged, and a test fails if one is.
- **`assistant_connections`.** One row per member, client and workspace: id, `workspace_id`, `user_id`, `client_id`, `client_name`, `permission` (`read | draft`), `status` (`pending | active | revoked`), timestamps and `last_used_at`. It has Row-Level Security and composite foreign keys (ADR 0006). A connection is created `pending` on first use, approved in the web app from the LAN (D13), and revocable by its member or by the owner. Every delegated request checks the connection's status, and `workspaces.assistant_access`.
- **A guard in the database.** For a delegated request the API sets `app.client_kind = 'assistant'`. Restrictive `INSERT`, `UPDATE` and `DELETE` policies on every workspace table refuse writes under that value, except on the draft tables, `assistant_connections` and `audit_log`. A schema test reads the catalog and fails on any workspace table without them. Read paths with a write side effect (the expiry of import staging, which deletes rows) either stay closed to assistants or skip that effect for them.
- **Drafts (0.4.2).**
  - `trade_drafts`: buy, sell, dividend, fee and tax only; they expire after 7 days. `SELECT`, `INSERT` and `DELETE` only, with no foreign key or trigger to `trades`.
  - Transaction drafts live in `staged_transactions` with `source`, `created_by` and `connection_id`, or in a sibling table; the mockup decides.
  - A draft becomes real only in the web app. A trade draft is confirmed through `POST /trades` with `fromDraftId`, which runs every check a trade normally gets, and the draft is deleted in the same database transaction.

## Discarded alternatives

- **The MCP server inside the API process, or with its own database access.** It would bypass the API's checks or duplicate them, and give an internet-facing process database credentials.
- **Passing the client's token through to the API.** The API would accept tokens issued for another audience, and a token stolen from the MCP server would be valid against the API as it is. Token exchange gives a short-lived, reduced-scope token instead.
- **Static bearer tokens or personal API keys (D19).** Long-lived, hard to rotate, and they bypass Keycloak's multi-factor authentication and session limits.
- **Dynamic client registration or client ID metadata documents (D11).** They let anyone on the internet create a client in the realm; the household has a handful of known clients.
- **Direct writes by a remote assistant (D5').** A prompt-injected assistant could move money; drafts confirmed by a person stop that.
- **Approving connections from the internet (D13).** A stolen password and second factor would be enough to connect a new assistant; requiring the LAN adds physical presence.
- **A third-party tunnel that terminates TLS (D9).** It would see every request and token in plaintext.
- **Exposing the whole Keycloak.** Only the sign-in and token paths are needed; the admin and account consoles stay on the LAN.
- **Remote access to encrypted workspaces (D6).** The server cannot read them, and a remote assistant would need the workspace key outside the member's devices.
- **Refresh tokens stored on disk by the local server (D4).** A file on the laptop would outlive the session and be readable by any process of the user.

## Residual risks

- **Internet-facing software.** Keycloak and the MCP server, once reachable from the internet, need prompt patching; an unpatched vulnerability is exposed to every address the allowlist admits.
- **Data leaves the house.** What an assistant reads goes to the model provider, and the refresh token of a remote connection lives in the member's account with that provider: members need multi-factor authentication there too.
- **Leaks through a prompt-injected assistant.** Drafts stop writes, not leaks: an assistant that read the workspace can still repeat what it read wherever its own tools allow.
- **The assistant's words are not ours.** Tool results are neutral, but the assistant may phrase them as advice; the app cannot prevent that.
- **Shared address ranges.** The provider's ranges are shared by all its users, so the IP allowlist only narrows who can reach the endpoints; authentication remains the real boundary.
- **One household client secret (D18).** If the secret of `claude-hosted` leaks, every member's remote connection depends on rotating it.
- **Keycloak behaviours to confirm.** How the target Keycloak handles `offline_access`, root-level discovery rewrites, client ID metadata documents and redirect checks on registration is confirmed by a spike before 0.4.1 builds on it.
- **Approval only from the LAN is deliberate.** A member away from home cannot approve a new connection until they are back; this is accepted.

## Consequences

- Milestone 0.2.8 ships the local, read-only server; 0.4.0 adds rate limiting and the Keycloak upgrade and hardening; 0.4.1 the remote server, with connection approval and the database guard; 0.4.2 drafts. Local access to encrypted workspaces waits for 0.8.0.
- Every new API route decides whether assistants may use it; the default is no.
- Every new workspace table gets the restrictive no-assistant-write policies, or the schema test fails.
- The household runs and patches one more host, the relay; it holds no keys and sees only encrypted traffic, its timing and its volume.
