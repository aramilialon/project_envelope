/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Where `apps/api` runs; see `.env.example`. */
  readonly VITE_API_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
