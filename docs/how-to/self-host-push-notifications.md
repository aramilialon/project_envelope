# Self-host push notifications

Goal: get a self-hosted instance sending real push notifications (the instant budget alerts, `#40`), not just the web app's own in-app alert.

## 1. Web Push (browser), working today

The `web` adapter (`#39`) is the only one with a real consumer right now — the web app subscribes a browser to Web Push, and the server signs every notification with your instance's own VAPID key pair.

Generate one, once per instance:

```bash
$ npx web-push generate-vapid-keys
=======================================

Public Key:
BPJ2jPhwkV5-KbVUbfgqPtwi6wTgYHtSLPQ_95_pe-woPKxVHA2KbhqDotagFHEp9Wy7ek8ML1cHoj8_zK9LU-c

Private Key:
Tns8KowO8sAdimD4b-SloSrgxB8BxhbTkUHF146tAsk

=======================================
```

Set the three variables `apps/api/.env.example` documents:

```bash
VAPID_SUBJECT=mailto:you@example.com   # or an https:// URL; how a push service reaches you if it needs to
VAPID_PUBLIC_KEY=BPJ2jPhwkV5-KbVUbfgqPtwi6wTgYHtSLPQ_95_pe-woPKxVHA2KbhqDotagFHEp9Wy7ek8ML1cHoj8_zK9LU-c
VAPID_PRIVATE_KEY=Tns8KowO8sAdimD4b-SloSrgxB8BxhbTkUHF146tAsk
```

`VAPID_SUBJECT` must be an address or URL a push service (Mozilla's, Google's...) can use to contact you if your server is misbehaving — a real one, not the example above.

Notes:

- `.env` is ignored by Git (root `.gitignore`); never commit a real private key.
- Keep the same pair once real users have subscribed: a browser's own subscription is tied to the public key it received, so rotating the pair invalidates every existing subscription (each browser re-subscribes on its next visit, but silently misses any push sent in between).
- The server refuses to start without all three variables set (`loadPushConfig`, `apps/api/src/config.ts`) — the `budget-recompute` job (`#40`) can enqueue a real send the moment it registers.

## 2. iOS (APNs) and Android (FCM), not yet

`apps/api/src/notifications/unimplemented-driver.ts` stands in for both: there is no real device to send to until the mobile app exists (milestone `0.3.0`, design.md's roadmap). Nothing to obtain or configure yet — this guide will grow a section for each once that milestone builds its own real adapter.
