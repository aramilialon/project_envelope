import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithIntl } from "../test-utils.tsx";
import * as api from "./api.ts";
import NotificationsToggle from "./NotificationsToggle.tsx";

const { useAuth } = vi.hoisted(() => ({ useAuth: vi.fn() }));
vi.mock("react-oidc-context", () => ({ useAuth }));

/** A minimal fake `PushSubscription`, just enough for `.toJSON()`/`.unsubscribe()` to work. */
function fakeSubscription() {
  return {
    toJSON: () => ({ endpoint: "https://push.example/abc", keys: { p256dh: "k", auth: "a" } }),
    unsubscribe: vi.fn().mockResolvedValue(true),
  };
}

function mockServiceWorker(getSubscription: () => Promise<unknown>) {
  const pushManager = {
    getSubscription: vi.fn().mockImplementation(getSubscription),
    subscribe: vi.fn().mockResolvedValue(fakeSubscription()),
  };
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: { ready: Promise.resolve({ pushManager }) },
  });
  Object.defineProperty(window, "PushManager", { configurable: true, value: function PushManager() {} });
  return pushManager;
}

describe("NotificationsToggle (#61)", () => {
  beforeEach(() => {
    useAuth.mockReturnValue({ user: { access_token: "t" } });
    Object.defineProperty(window, "Notification", {
      configurable: true,
      value: { permission: "default", requestPermission: vi.fn().mockResolvedValue("granted") },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // @ts-expect-error -- test-only cleanup of a property defineProperty added.
    delete navigator.serviceWorker;
    // @ts-expect-error -- test-only cleanup of a property defineProperty added.
    delete window.PushManager;
    // @ts-expect-error -- test-only cleanup of a property defineProperty added.
    delete window.Notification;
  });

  it("renders nothing when the browser does not support Web Push at all", () => {
    const { container } = renderWithIntl(<NotificationsToggle />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when notification permission was already denied", () => {
    mockServiceWorker(() => Promise.resolve(undefined));
    Object.defineProperty(window, "Notification", { configurable: true, value: { permission: "denied" } });
    const { container } = renderWithIntl(<NotificationsToggle />);
    expect(container).toBeEmptyDOMElement();
  });

  it("offers to enable notifications when not yet subscribed, and subscribes on click", async () => {
    const pushManager = mockServiceWorker(() => Promise.resolve(undefined));
    vi.spyOn(api, "getPushPublicKey").mockResolvedValue("dGVzdA");
    const register = vi.spyOn(api, "registerDeviceToken").mockResolvedValue(undefined);

    renderWithIntl(<NotificationsToggle />);
    const button = await screen.findByRole("button", { name: "Enable notifications" });

    fireEvent.click(button);
    await waitFor(() => expect(pushManager.subscribe).toHaveBeenCalled());
    await waitFor(() => expect(register).toHaveBeenCalledWith("t", JSON.stringify({ endpoint: "https://push.example/abc", keys: { p256dh: "k", auth: "a" } })));
    expect(await screen.findByRole("button", { name: "Disable notifications" })).toBeInTheDocument();
  });

  it("offers to disable notifications when already subscribed, and unsubscribes on click", async () => {
    const subscription = fakeSubscription();
    mockServiceWorker(() => Promise.resolve(subscription));
    const remove = vi.spyOn(api, "removeDeviceToken").mockResolvedValue(undefined);

    renderWithIntl(<NotificationsToggle />);
    const button = await screen.findByRole("button", { name: "Disable notifications" });

    fireEvent.click(button);
    await waitFor(() => expect(subscription.unsubscribe).toHaveBeenCalled());
    await waitFor(() =>
      expect(remove).toHaveBeenCalledWith("t", JSON.stringify({ endpoint: "https://push.example/abc", keys: { p256dh: "k", auth: "a" } })),
    );
    expect(await screen.findByRole("button", { name: "Enable notifications" })).toBeInTheDocument();
  });
});
