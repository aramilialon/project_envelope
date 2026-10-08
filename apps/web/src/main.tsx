import it from "@envelope/i18n/locales/it.json";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { IntlProvider } from "react-intl";
import { AuthProvider } from "react-oidc-context";
import { BrowserRouter } from "react-router-dom";

import App from "./App.tsx";
import { oidcConfig } from "./auth/config.ts";
import { negotiateLocale } from "./i18n/negotiateLocale.ts";
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

// The browser's own ordered language preferences (#62, ADR 0004) — there is no "your account"
// settings screen yet to override this with a stored preference, so this is the whole of
// "locale negotiation" for now. English never passes a `messages` catalog of its own: every
// component's own `defaultMessage` already *is* the English text, so relying on it (rather than
// a second, generated copy that could drift out of sync) is the one copy that can never go stale.
const locale = negotiateLocale(navigator.languages ?? [navigator.language]);

createRoot(root).render(
  <StrictMode>
    <IntlProvider locale={locale} defaultLocale="en" messages={locale === "it" ? it : {}}>
      <AuthProvider {...oidcConfig}>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </AuthProvider>
    </IntlProvider>
  </StrictMode>,
);
