-- Run by PostgreSQL only when the data volume is first created.
-- Keycloak uses its own database, separate from the app's, on the same server.
CREATE DATABASE keycloak OWNER envelope;
