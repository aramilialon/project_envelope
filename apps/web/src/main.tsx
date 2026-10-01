import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { IntlProvider } from "react-intl";
import { AuthProvider } from "react-oidc-context";
import { BrowserRouter } from "react-router-dom";

import App from "./App.tsx";
import { oidcConfig } from "./auth/config.ts";
// Self-hosted (docs/design.md: a self-hosted install must not call third-party servers, unlike
// the mockups' own Google Fonts link). The variable builds, not the static-weight ones: the
// `wdth` axis they carry is what lets titles/big figures use the narrowed width design.md calls
// for — `wdth.css` is Bricolage Grotesque's own variable-width file, `wght.css` Figtree's
// variable-weight one (Figtree is never narrowed, so its default axis is all it needs).
import "@fontsource-variable/bricolage-grotesque/wdth.css";
import "@fontsource-variable/figtree/wght.css";
import "./index.css";

const root = document.getElementById("root");
if (!root) {
  throw new Error("main.tsx: #root element not found");
}

createRoot(root).render(
  <StrictMode>
    {/* locale is fixed to "en" (the source language) until #62 adds the Italian catalog
        and a real locale negotiation; "defaultMessage" alone covers every string until then. */}
    <IntlProvider locale="en" defaultLocale="en" messages={{}}>
      <AuthProvider {...oidcConfig}>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </AuthProvider>
    </IntlProvider>
  </StrictMode>,
);
