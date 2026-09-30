/**
 * Push notification delivery (design.md, "Notifications"; #39): one interface,
 * one adapter per platform (`web-push-driver.ts` today, real; `ios`/`android`
 * deferred until the mobile app, 0.3.0, gives them a real consumer).
 */

export interface PushPayload {
  /** The triggering job's id (#36): used as the platform's own coalescing key, so a duplicate
   * delivery replaces rather than duplicates a still-pending notification on the device. */
  readonly notificationId: string;
  readonly title: string;
  readonly body: string;
}

export type PushOutcome =
  | "sent"
  /** The platform reports this token as permanently gone (unregistered, expired): the caller should stop using it. */
  | "invalid_token"
  /** A transient failure (network, a 5xx from the push service): worth retrying later, the token itself may still be good. */
  | "failed";

export interface PushDriver {
  /** `token` is however this platform stores a device's own identity — for `web`, a JSON-serialized push subscription. */
  send(token: string, payload: PushPayload): Promise<PushOutcome>;
}
