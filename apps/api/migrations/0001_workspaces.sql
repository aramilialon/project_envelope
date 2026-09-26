CREATE TABLE workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  base_currency text NOT NULL,
  time_zone text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
