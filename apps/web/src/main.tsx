import { SOURCE_LOCALE, type Catalog } from "@envelope/i18n";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { IntlProvider } from "react-intl";
import { AuthProvider } from "react-oidc-context";
import { BrowserRouter } from "react-router-dom";

import App from "./App.tsx";
import { oidcConfig } from "./auth/config.ts";
import { loadCatalog } from "./i18n/catalogs.ts";
import { FormattingLocaleProvider } from "./i18n/FormattingLocale.tsx";
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
const rootElement = root;

function render(language: string, messages: Catalog): void {
  // The page's own language follows the interface's (#620): screen readers, hyphenation and the
  // browser's own spelling and translation offers all read it. `index.html` says "en" until here.
  document.documentElement.lang = language;
  // `IntlProvider`'s locale is the interface language: messages and their plural rules follow
  // it. The formatting locale for amounts and dates has a context of its own; it is the interface
  // language too for now (#620's follow-up moves the existing formatting calls onto it, and then
  // passes `negotiateLocale`'s own `formattingLocale` here).
  createRoot(rootElement).render(
    <StrictMode>
      <IntlProvider locale={language} defaultLocale={SOURCE_LOCALE} messages={messages}>
        <FormattingLocaleProvider locale={language}>
          <AuthProvider {...oidcConfig}>
            <BrowserRouter>
              <App />
            </BrowserRouter>
          </AuthProvider>
        </FormattingLocaleProvider>
      </IntlProvider>
    </StrictMode>,
  );
}

// The browser's own ordered language preferences (#62, ADR 0004) — there is no "your account"
// settings screen yet to override this with a stored preference. Only the chosen language's
// catalog is downloaded, as a chunk of its own (#620), and before the first render, so no screen
// flashes English first. Should that chunk fail to load (a deployment replaced it while this tab
// was open, say), the app still starts, in English, rather than showing a blank page.
const { language } = negotiateLocale(navigator.languages ?? [navigator.language]);
loadCatalog(language).then(
  (messages) => render(language, messages),
  (error: unknown) => {
    console.error(`main.tsx: could not load the "${language}" catalog, starting in English`, error);
    render(SOURCE_LOCALE, {});
  },
);
