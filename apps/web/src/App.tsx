import { useAuth } from "react-oidc-context";
import { Route, Routes } from "react-router-dom";

import SignIn from "./auth/SignIn.tsx";
import Home from "./Home.tsx";
import WorkspaceGate from "./workspaces/WorkspaceGate.tsx";

export default function App() {
  const auth = useAuth();

  if (!auth.isAuthenticated) {
    return <SignIn />;
  }

  return (
    <Routes>
      <Route path="/" element={<WorkspaceGate />} />
      <Route path="/:workspaceId" element={<Home />} />
    </Routes>
  );
}
