import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { IntlProvider } from "react-intl";
import { AuthProvider } from "react-oidc-context";

import App from "./App.tsx";
import { oidcConfig } from "./auth/config.ts";
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
        <App />
      </AuthProvider>
    </IntlProvider>
  </StrictMode>,
);
