/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Where `apps/api` runs; see `.env.example`. */
  readonly VITE_API_URL: string;
  /** The "envelope" Keycloak realm's issuer URL, e.g. http://127.0.0.1:8080/realms/envelope. */
  readonly VITE_KEYCLOAK_ISSUER: string;
  /** The public client created by `scripts/keycloak/bootstrap.sh` (default: "envelope-api"). */
  readonly VITE_KEYCLOAK_CLIENT_ID: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
