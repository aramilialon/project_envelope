# apps

The applications will live here, each one a package of the monorepo:

| Folder | Contents | Phase |
| --- | --- | --- |
| [`api`](api/README.md) | Node.js server: API, sync, background jobs | 0–1 |
| `web` | React app for the browser | 1 |
| `mobile` | Expo app for iOS and Android | 3 |

They all use the logic in `packages/core`, so calculations are identical everywhere. Every user-facing string goes through translation catalogs (see [ADR 0004](../docs/adr/0004-internationalization.md)).
