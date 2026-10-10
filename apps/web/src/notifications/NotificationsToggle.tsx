import { useIntl } from "react-intl";

import { usePushSubscription } from "./usePushSubscription.ts";

/**
 * Web Push opt-in for this one browser (#61, design.md "Notifications": "users choose which
 * alerts they receive and on which devices"). The mockup's own "Notifications" settings tab
 * (`docs/ux/mockups/settings-first-run.html`, per-workspace preferences) belongs to the wider
 * account-settings screen design.md defers to 0.1.8 ("the rest is 0.1.8 and later") — with only
 * one alert type so far (budget problems), a single band-level on/off toggle here is enough
 * until that fuller settings screen exists to host per-alert-type choices instead.
 *
 * Renders nothing when the browser cannot do Web Push at all, or already refused the permission
 * at the browser level (`Notification.permission === "denied"`) — there is nothing this control
 * could still do in either case except dead-end the person clicking it.
 */
export default function NotificationsToggle() {
  const intl = useIntl();
  const { state, subscribe, unsubscribe } = usePushSubscription();

  if (state === "unsupported" || state === "denied" || state === "loading") {
    return null;
  }

  if (state === "subscribed") {
    return (
      <button type="button" className="me" onClick={() => void unsubscribe()}>
        {intl.formatMessage({ id: "notifications.disable", defaultMessage: "Disable notifications" })}
      </button>
    );
  }

  return (
    <button type="button" className="me" onClick={() => void subscribe()}>
      {intl.formatMessage({ id: "notifications.enable", defaultMessage: "Enable notifications" })}
    </button>
  );
}
