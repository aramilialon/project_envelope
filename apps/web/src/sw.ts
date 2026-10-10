/// <reference lib="webworker" />

/**
 * The service worker (#48's own PWA shell, `vite-plugin-pwa`'s `injectManifest` strategy): owns
 * precaching (what `generateSW` used to write automatically) and, new for `#61`, the two Web
 * Push event handlers a generated one has no room for — `push` shows the budget alert the server
 * already composed (`apps/api`'s `web-push-driver.ts` sends `{title, body}`, nothing else to
 * translate here, same as every other push notification body sent as opaque JSON); where it
 * should link once clicked is still open for the web app (design.md), so this just focuses or
 * opens the app's own root.
 */
import { precacheAndRoute } from "workbox-precaching";

declare let self: ServiceWorkerGlobalScope;

precacheAndRoute(self.__WB_MANIFEST);

interface BudgetAlertPayload {
  readonly title: string;
  readonly body: string;
}

self.addEventListener("push", (event: PushEvent) => {
  const payload = event.data?.json() as BudgetAlertPayload | undefined;
  if (!payload) {
    return;
  }
  event.waitUntil(self.registration.showNotification(payload.title, { body: payload.body }));
});

self.addEventListener("notificationclick", (event: NotificationEvent) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      const existing = clients.find((client) => "focus" in client);
      if (existing) {
        return (existing as WindowClient).focus();
      }
      return self.clients.openWindow("/");
    }),
  );
});
