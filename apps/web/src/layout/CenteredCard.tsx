import type { ReactNode } from "react";

import "./CenteredCard.css";

/**
 * The full-viewport, centered card every screen before there is a band to put anything else in
 * uses (#332, `docs/ux/mockups/sign-in.html`'s own `.card`): sign-in (#49) and choosing a
 * workspace (#50). Previously duplicated almost identically as `SignIn.css`'s `.sign-in-card` and
 * `WorkspacePicker.css`'s `.workspace-card` — one shared component and stylesheet instead.
 */
export default function CenteredCard({ children }: { children: ReactNode }) {
  return (
    <div className="centered-card">
      <main className="card" aria-live="polite">
        {children}
      </main>
    </div>
  );
}
