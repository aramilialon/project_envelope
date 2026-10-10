import type { FastifyInstance } from "fastify";

import type { DbPool } from "../db/pool.ts";
import { registerDeviceToken, removeDeviceToken, type DevicePlatform } from "../notifications/repository.ts";

const DEVICE_PLATFORMS: readonly DevicePlatform[] = ["ios", "android", "web"];

function parseDeviceToken(body: Record<string, unknown>): { platform: DevicePlatform; token: string } | undefined {
  const { platform, token } = body;
  if (typeof platform !== "string" || !DEVICE_PLATFORMS.includes(platform as DevicePlatform) || typeof token !== "string" || !token) {
    return undefined;
  }
  return { platform: platform as DevicePlatform, token };
}

/**
 * Web Push opt-in (`#61`, design.md "Notifications": "users choose which alerts they receive and
 * on which devices"). `vapidPublicKey` is, as its name says, public — the subscribing browser
 * needs it to create its own `PushSubscription`, and only the matching private key (kept
 * server-side, `web-push-driver.ts`) can actually sign a push through it — so `GET
 * .../push-public-key` needs no request body or workspace, just an authenticated caller, like
 * `POST .../device-tokens` below it.
 */
export function registerDeviceTokensRoutes(app: FastifyInstance, pool: DbPool, vapidPublicKey: string): void {
  app.get("/me/push-public-key", async () => {
    return { publicKey: vapidPublicKey };
  });

  app.post("/me/device-tokens", async (request, reply) => {
    if (!request.userId) {
      throw new Error("registerDeviceTokensRoutes: request.userId was not set — is the user mapper preHandler registered?");
    }
    const parsed = parseDeviceToken((request.body ?? {}) as Record<string, unknown>);
    if (!parsed) {
      await reply.code(400).send({ error: `invalid device token: platform (one of ${DEVICE_PLATFORMS.join(", ")}) and a non-empty token are required` });
      return;
    }
    await registerDeviceToken(pool, request.userId, parsed.platform, parsed.token);
    await reply.code(204).send();
  });

  app.delete("/me/device-tokens", async (request, reply) => {
    if (!request.userId) {
      throw new Error("registerDeviceTokensRoutes: request.userId was not set — is the user mapper preHandler registered?");
    }
    const parsed = parseDeviceToken((request.body ?? {}) as Record<string, unknown>);
    if (!parsed) {
      await reply.code(400).send({ error: `invalid device token: platform (one of ${DEVICE_PLATFORMS.join(", ")}) and a non-empty token are required` });
      return;
    }
    await removeDeviceToken(pool, request.userId, parsed.platform, parsed.token);
    await reply.code(204).send();
  });
}
