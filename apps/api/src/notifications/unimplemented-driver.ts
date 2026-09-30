/**
 * APNs and Android/FCM (design.md, "Notifications"): deferred until the mobile app
 * (milestone 0.3.0) gives them a real device to send to — building and testing
 * those adapters now, with no possible real consumer, would be speculative (#39).
 * Same `PushDriver` shape as `web-push-driver.ts`, so wiring in the real adapter
 * later is a one-line change, not a redesign.
 */
import type { PushDriver } from "./driver.ts";

export function createUnimplementedPushDriver(platform: "ios" | "android"): PushDriver {
  return {
    send(): Promise<never> {
      return Promise.reject(new Error(`push delivery for "${platform}" is not implemented yet (#39)`));
    },
  };
}
