/**
 * Push delivery dispatch (design.md, "Notifications"; #39): given a job id and the notification
 * content, sends it to every one of a user's registered devices, resuming only from unconfirmed
 * deliveries — a device already marked `sent` for this job is never re-delivered.
 */
import type { DbClient, DbPool } from "../db/pool.ts";
import type { PushDriver, PushPayload } from "./driver.ts";

export interface PushDrivers {
  readonly web: PushDriver;
  readonly ios: PushDriver;
  readonly android: PushDriver;
}

interface DeviceTokenRow {
  readonly id: string;
  readonly platform: "ios" | "android" | "web";
  readonly token: string;
}

export interface NotificationContent {
  readonly title: string;
  readonly body: string;
}

export async function sendPushToUser(
  db: DbPool | DbClient,
  drivers: PushDrivers,
  jobId: string,
  userId: string,
  content: NotificationContent,
): Promise<void> {
  const { rows: devices } = await db.query<DeviceTokenRow>("SELECT id, platform, token FROM device_tokens WHERE user_id = $1", [
    userId,
  ]);

  for (const device of devices) {
    const { rows: existing } = await db.query<{ status: string }>(
      "SELECT status FROM notification_deliveries WHERE job_id = $1 AND device_token_id = $2",
      [jobId, device.id],
    );
    if (existing[0]?.status === "sent") {
      continue;
    }
    if (!existing[0]) {
      await db.query("INSERT INTO notification_deliveries (job_id, device_token_id, title, body) VALUES ($1, $2, $3, $4)", [
        jobId,
        device.id,
        content.title,
        content.body,
      ]);
    }

    const payload: PushPayload = { notificationId: jobId, ...content };
    const outcome = await drivers[device.platform].send(device.token, payload);

    if (outcome === "sent") {
      await db.query("UPDATE notification_deliveries SET status = 'sent', sent_at = now() WHERE job_id = $1 AND device_token_id = $2", [
        jobId,
        device.id,
      ]);
    } else if (outcome === "invalid_token") {
      // Cascades onto this delivery row too: once the device itself is gone there is no
      // destination left for it to describe.
      await db.query("DELETE FROM device_tokens WHERE id = $1", [device.id]);
    }
    // "failed" (a transient error): the row stays 'pending', left for a future retry.
  }
}
