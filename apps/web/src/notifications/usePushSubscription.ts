import { useEffect, useState } from "react";
import { useAuth } from "react-oidc-context";

import { getPushPublicKey, registerDeviceToken, removeDeviceToken } from "./api.ts";
import { urlBase64ToUint8Array } from "./vapidKey.ts";

export type PushSubscriptionState = "unsupported" | "loading" | "unsubscribed" | "subscribed" | "denied" | "error";

function supportsPush(): boolean {
  return "serviceWorker" in navigator && "PushManager" in window;
}

/**
 * Web Push opt-in (#61, design.md "Notifications": "users choose which alerts they receive and
 * on which devices") for this one browser. `state` reflects this device's own current
 * subscription (checked against the service worker's own `PushManager`, not just "did we ever
 * call subscribe"), so a permission the user later revokes in the browser's own settings is
 * picked up the next time this hook mounts, not left showing a stale "subscribed".
 */
export function usePushSubscription(): {
  readonly state: PushSubscriptionState;
  subscribe(): Promise<void>;
  unsubscribe(): Promise<void>;
} {
  const auth = useAuth();
  const [state, setState] = useState<PushSubscriptionState>(() => {
    if (!supportsPush()) {
      return "unsupported";
    }
    return Notification.permission === "denied" ? "denied" : "loading";
  });

  useEffect(() => {
    if (!supportsPush() || Notification.permission === "denied") {
      return;
    }
    let cancelled = false;
    navigator.serviceWorker.ready
      .then((registration) => registration.pushManager.getSubscription())
      .then((subscription) => {
        if (!cancelled) {
          setState(subscription ? "subscribed" : "unsubscribed");
        }
      })
      .catch(() => {
        if (!cancelled) {
          setState("error");
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function subscribe(): Promise<void> {
    const accessToken = auth.user?.access_token;
    if (!accessToken) {
      return;
    }
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      setState("denied");
      return;
    }
    try {
      const [registration, publicKey] = await Promise.all([navigator.serviceWorker.ready, getPushPublicKey(accessToken)]);
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
      await registerDeviceToken(accessToken, JSON.stringify(subscription.toJSON()));
      setState("subscribed");
    } catch {
      setState("error");
    }
  }

  async function unsubscribe(): Promise<void> {
    const accessToken = auth.user?.access_token;
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        const token = JSON.stringify(subscription.toJSON());
        await subscription.unsubscribe();
        if (accessToken) {
          await removeDeviceToken(accessToken, token);
        }
      }
      setState("unsubscribed");
    } catch {
      setState("error");
    }
  }

  return { state, subscribe, unsubscribe };
}
