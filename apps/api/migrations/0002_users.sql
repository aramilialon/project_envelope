-- Password hashes, passkeys and 2FA live in Keycloak, not here (design.md,
-- "Authentication with Keycloak"): this table only mirrors the identity Keycloak
-- already manages, plus the app-level preferences ADR 0004 requires.
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  keycloak_subject text NOT NULL UNIQUE,
  email text NOT NULL UNIQUE,
  language text NOT NULL DEFAULT 'en',
  locale text NOT NULL DEFAULT 'en-US',
  time_zone text NOT NULL DEFAULT 'UTC',
  created_at timestamptz NOT NULL DEFAULT now()
);
