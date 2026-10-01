import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { VitePWA } from "vite-plugin-pwa";

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      manifest: {
        name: "envelope",
        short_name: "envelope",
        description: "Budget and investment portfolios, self-hosted",
        // docs/design.md, "Visual language": desk (page ground) and pen (buttons, links).
        background_color: "#ecece8",
        theme_color: "#2340a0",
        display: "standalone",
        // A single SVG icon for now (#48's own scope is the PWA shell, not the app icon set):
        // proper multi-resolution PNG/maskable icons are a visual-design follow-up.
        icons: [{ src: "/favicon.svg", sizes: "any", type: "image/svg+xml" }],
      },
    }),
  ],
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test-setup.ts"],
    // Vitest's own default include pattern also matches "*.spec.ts", which would otherwise
    // pick up e2e/*.spec.ts (Playwright's own tests, run separately via `test:e2e`).
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
