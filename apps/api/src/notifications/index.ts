import type { PushConfig } from "../config.ts";
import type { PushDrivers } from "./repository.ts";
import { createUnimplementedPushDriver } from "./unimplemented-driver.ts";
import { createWebPushDriver } from "./web-push-driver.ts";

export type { PushDriver, PushOutcome, PushPayload } from "./driver.ts";
export type { NotificationContent, PushDrivers } from "./repository.ts";
export { sendPushToUser } from "./repository.ts";

/** `ios`/`android` are stubs until the mobile app (0.3.0) gives them a real device to send to (#39). */
export function createPushDrivers(config: PushConfig): PushDrivers {
  return {
    web: createWebPushDriver({ subject: config.vapidSubject, publicKey: config.vapidPublicKey, privateKey: config.vapidPrivateKey }),
    ios: createUnimplementedPushDriver("ios"),
    android: createUnimplementedPushDriver("android"),
  };
}
