-- Push notification delivery (design.md, "Notifications"; #39): a device token
-- belongs to a user, not a workspace (a user's own devices, shared across every
-- workspace they are a member of), so this is scoped by app_user_id(), the same
-- function memberships already uses for its own user-scoped policy (ADR 0006).
CREATE TABLE device_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- 'web' stores a JSON-serialized Web Push subscription (endpoint + keys) as this platform's
  -- own "token"; 'ios'/'android' will store a plain APNs/FCM device token once #39's other two
  -- adapters have a real consumer (the mobile app, 0.3.0).
  platform text NOT NULL CHECK (platform IN ('ios', 'android', 'web')),
  token text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, platform, token)
);

CREATE INDEX device_tokens_user_id_idx ON device_tokens (user_id);

ALTER TABLE device_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY user_isolation ON device_tokens
  USING (user_id = app_user_id())
  WITH CHECK (user_id = app_user_id());
GRANT SELECT, INSERT, DELETE ON device_tokens TO envelope_app;

-- "A notification -> destination table (the notification's content plus which device tokens
-- it goes to) is enough" (design.md). One row per (job, device): the job id is the idempotency
-- key for the *external* effect (design.md, "Queue module" safeguard #3), since #36's own
-- processed_jobs only guards the database effects inside one transaction — a handler that
-- crashes after delivering to one of a user's several devices must resume only from the
-- others on any retry, never re-deliver to a device already marked sent.
CREATE TABLE notification_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL,
  device_token_id uuid NOT NULL REFERENCES device_tokens (id) ON DELETE CASCADE,
  title text NOT NULL,
  body text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'sent', 'failed')) DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  UNIQUE (job_id, device_token_id)
);

CREATE INDEX notification_deliveries_device_token_id_idx ON notification_deliveries (device_token_id);

-- No user_id of its own: reached only through device_tokens (already user-scoped), so RLS here
-- is enforced by joining through it rather than repeating app_user_id() on this table too.
ALTER TABLE notification_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_deliveries FORCE ROW LEVEL SECURITY;
CREATE POLICY user_isolation ON notification_deliveries
  USING (device_token_id IN (SELECT id FROM device_tokens WHERE user_id = app_user_id()))
  WITH CHECK (device_token_id IN (SELECT id FROM device_tokens WHERE user_id = app_user_id()));
GRANT SELECT, INSERT, UPDATE ON notification_deliveries TO envelope_app;
