import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import https from "node:https";
import { after, before, describe, it, mock } from "node:test";

import webpush from "web-push";

import { createWebPushDriver } from "./web-push-driver.ts";

/**
 * Intercepts Node's own `https.request`, the exact boundary `web-push` itself calls through
 * (confirmed in its source: `https.request(httpsOptions, callback)`), so every layer above it —
 * VAPID JWT signing, payload encryption, the `Topic` header — is the real library doing real
 * work; only the final network round trip (and its response status) is substituted, the way a
 * real push service's reply would arrive.
 */
class FakeHttpsRequest {
  responseStatus = 201;
  lastRequest: { headers: Record<string, unknown>; body: string } | undefined;

  install(): { restore(): void } {
    const mocked = mock.method(https, "request", (options: https.RequestOptions, callback: (res: EventEmitter & { statusCode: number; headers: object }) => void) => {
      const req = new EventEmitter() as EventEmitter & { write(chunk: unknown): void; end(): void };
      let body = "";
      req.write = (chunk: unknown) => {
        body += String(chunk);
      };
      req.end = () => {
        this.lastRequest = { headers: (options.headers ?? {}) as Record<string, unknown>, body };
        const res = new EventEmitter() as EventEmitter & { statusCode: number; headers: object };
        res.statusCode = this.responseStatus;
        res.headers = {};
        callback(res);
        queueMicrotask(() => res.emit("end"));
      };
      return req;
    });
    return { restore: () => mocked.mock.restore() };
  }
}

describe("web push driver", () => {
  const fake = new FakeHttpsRequest();
  let restore: () => void;
  const vapidKeys = webpush.generateVAPIDKeys();
  const driver = createWebPushDriver({ subject: "mailto:test@example.com", publicKey: vapidKeys.publicKey, privateKey: vapidKeys.privateKey });

  before(() => {
    restore = fake.install().restore;
  });

  after(() => {
    restore();
  });

  function subscriptionToken(): string {
    // A syntactically valid p256dh/auth pair (real Web Push crypto keys): p256dh is an EC
    // P-256 public key (the same shape a VAPID key pair uses), auth is the spec's own 16
    // random bytes, base64url-encoded.
    const keys = webpush.generateVAPIDKeys();
    return JSON.stringify({
      endpoint: "https://push.example.com/subscription/abc",
      keys: { p256dh: keys.publicKey, auth: Buffer.from(randomUUID().replace(/-/g, ""), "hex").toString("base64url") },
    });
  }

  it('sends successfully and reports "sent"', async () => {
    fake.responseStatus = 201;
    const outcome = await driver.send(subscriptionToken(), {
      notificationId: randomUUID(),
      title: "Overspent",
      body: "Groceries is negative",
    });
    assert.equal(outcome, "sent");
    assert.ok(fake.lastRequest);
  });

  it("uses the notification id, dashes stripped, as the coalescing topic", async () => {
    fake.responseStatus = 201;
    const notificationId = randomUUID();
    await driver.send(subscriptionToken(), { notificationId, title: "T", body: "B" });
    const topicHeader = fake.lastRequest?.headers.Topic;
    assert.equal(topicHeader, notificationId.replace(/-/g, ""));

    // A second delivery of the very same job must carry the exact same topic: this is the
    // mechanism that makes the push service itself coalesce a duplicate instead of the phone
    // ever showing two (design.md, #39's own acceptance criterion).
    await driver.send(subscriptionToken(), { notificationId, title: "T", body: "B" });
    assert.equal(fake.lastRequest?.headers.Topic, notificationId.replace(/-/g, ""));
  });

  it('reports "invalid_token" for a 410 Gone response', async () => {
    fake.responseStatus = 410;
    const outcome = await driver.send(subscriptionToken(), { notificationId: randomUUID(), title: "T", body: "B" });
    assert.equal(outcome, "invalid_token");
  });

  it('reports "invalid_token" for a 404 Not Found response', async () => {
    fake.responseStatus = 404;
    const outcome = await driver.send(subscriptionToken(), { notificationId: randomUUID(), title: "T", body: "B" });
    assert.equal(outcome, "invalid_token");
  });

  it('reports "failed" for a transient server error', async () => {
    fake.responseStatus = 503;
    const outcome = await driver.send(subscriptionToken(), { notificationId: randomUUID(), title: "T", body: "B" });
    assert.equal(outcome, "failed");
  });
});
