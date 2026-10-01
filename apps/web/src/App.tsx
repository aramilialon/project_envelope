import { useAuth } from "react-oidc-context";
import { Route, Routes } from "react-router-dom";

import AccountsScreen from "./accounts/AccountsScreen.tsx";
import SignIn from "./auth/SignIn.tsx";
import BudgetScreen from "./budget/BudgetScreen.tsx";
import CategoriesScreen from "./categories/CategoriesScreen.tsx";
import AppLayout from "./layout/AppLayout.tsx";
import WorkspaceGate from "./workspaces/WorkspaceGate.tsx";

export default function App() {
  const auth = useAuth();

  if (!auth.isAuthenticated) {
    return <SignIn />;
  }

  return (
    <Routes>
      <Route path="/" element={<WorkspaceGate />} />
      <Route path="/:workspaceId" element={<AppLayout />}>
        <Route index element={<BudgetScreen />} />
        <Route path="accounts" element={<AccountsScreen />} />
        <Route path="settings/categories" element={<CategoriesScreen />} />
      </Route>
    </Routes>
  );
}
