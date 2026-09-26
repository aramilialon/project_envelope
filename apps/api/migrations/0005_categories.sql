CREATE TABLE category_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  name text NOT NULL,
  sort_order integer NOT NULL,
  archived boolean NOT NULL DEFAULT false
);

CREATE INDEX category_groups_workspace_id_idx ON category_groups (workspace_id);

CREATE TABLE categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  group_id uuid NOT NULL REFERENCES category_groups (id) ON DELETE CASCADE,
  name text NOT NULL,
  sort_order integer NOT NULL,
  archived boolean NOT NULL DEFAULT false
);

CREATE INDEX categories_workspace_id_idx ON categories (workspace_id);
CREATE INDEX categories_group_id_idx ON categories (group_id);
