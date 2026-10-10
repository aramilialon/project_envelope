import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { VitePWA } from "vite-plugin-pwa";

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      // injectManifest (not the default generateSW): Web Push (#61) needs its own `push`/
      // `notificationclick` handlers, which only a service worker source file this app owns
      // can add — generateSW's own auto-written one has no room for them.
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      manifest: {
        name: "envelope",
        short_name: "envelope",
        description: "Budget and investment portfolios, self-hosted",
        // docs/design.md, "Visual language": desk (page ground) and the mariner band.
        background_color: "#e4ecf5",
        theme_color: "#173b60",
        display: "standalone",
        // A single SVG icon for now (#48's own scope is the PWA shell, not the app icon set):
        // proper multi-resolution PNG/maskable icons are a visual-design follow-up.
        icons: [{ src: "/favicon.svg", sizes: "any", type: "image/svg+xml" }],
      },
      injectManifest: {
        // The default glob (js/css/html/ico/png/svg) does not include the self-hosted font
        // files (#323): without this, an installed, offline PWA would lose Bricolage
        // Grotesque/Figtree the moment the network is gone, even though self-hosting already
        // solved the "no third-party server" half of the problem.
        globPatterns: ["**/*.{js,css,html,ico,png,svg,woff2,md}"],
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
