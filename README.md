# envelope

Envelope budgeting and investment portfolios with target allocation and threshold-based rebalancing, in a single self-hosted web and mobile app.

> `envelope` is a code name. Status: **phase 0, foundations**.

## Quick start

Every step, from a fresh Debian 13 virtual machine to the first test, is in [docs/getting-started.md](docs/getting-started.md).

With the tools already installed:

```bash
pnpm install
pnpm test
```

## Layout

| Folder | Contents |
| --- | --- |
| `packages/core` | Pure domain logic: budget, portfolios, rebalancing. No network or database dependencies |
| `apps/` | Coming next: `api` (server), `web` (browser), `mobile` (Expo) |
| `infra/` | `docker-compose` for local development (PostgreSQL, Keycloak) and the Ansible playbook for the development VM |
| `docs/` | Getting started, how-to guides, architecture decision records (ADR), glossary |

## Languages

Code, comments, documentation and commit messages are in English. The user interface is translatable: English is the source language and Italian is the first translation. See [ADR 0004](docs/adr/0004-internationalization.md).

## Documentation

- [Design document](docs/design.md): vision, features, architecture, roadmap and decisions
- [Documentation index](docs/README.md)

## License

AGPL-3.0: see [LICENSE](LICENSE).
