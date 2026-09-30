/**
 * The `web` adapter (design.md, "Notifications"): Web Push behind `PushDriver`.
 * The only file in the codebase allowed to import "web-push".
 */
import webpush, { WebPushError, type PushSubscription } from "web-push";

import type { PushDriver, PushOutcome, PushPayload } from "./driver.ts";

export interface WebPushConfig {
  readonly subject: string;
  readonly publicKey: string;
  readonly privateKey: string;
}

const GONE_STATUSES = new Set([404, 410]);

export function createWebPushDriver(config: WebPushConfig): PushDriver {
  return {
    async send(token: string, payload: PushPayload): Promise<PushOutcome> {
      const subscription = JSON.parse(token) as PushSubscription;
      try {
        await webpush.sendNotification(subscription, JSON.stringify({ title: payload.title, body: payload.body }), {
          vapidDetails: config,
          // The Web Push protocol's own coalescing key (design.md, "the phone replaces a
          // duplicate instead of showing it twice"): a UUID's 32 hex characters fit the
          // 32-character, filename-safe-charset limit exactly once the dashes are stripped.
          topic: payload.notificationId.replace(/-/g, ""),
        });
        return "sent";
      } catch (error) {
        if (error instanceof WebPushError && GONE_STATUSES.has(error.statusCode)) {
          return "invalid_token";
        }
        return "failed";
      }
    },
  };
}
