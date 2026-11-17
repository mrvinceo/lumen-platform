import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Outlet, Route, Routes } from "react-router";
import { Alert, Spinner } from "./components/ui";
import "./index.css";
import { MeProvider, useMe } from "./lib/session";
import { CreateWorkspacePage, LoginPage, SignupPage } from "./pages/Auth";
import { KnowledgePage } from "./pages/Knowledge";
import { KnowledgeBasePage } from "./pages/KnowledgeBase";
import { AppLayout } from "./pages/Layout";
import { ModelsPage } from "./pages/Models";
import { ComingSoonPage, OverviewPage } from "./pages/Overview";
import { SettingsPage } from "./pages/Settings";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-full items-center justify-center p-6">{children}</div>;
}

/** Signed in AND has an active workspace. */
function RequireWorkspace() {
  const me = useMe();
  if (me.isLoading)
    return (
      <Centered>
        <Spinner />
      </Centered>
    );
  if (me.error)
    return (
      <Centered>
        <Alert tone="danger">Could not reach the Lumen API: {(me.error as Error).message}</Alert>
      </Centered>
    );
  if (!me.data) return <Navigate to="/login" replace />;
  if (!me.data.tenant) return <Navigate to="/welcome" replace />;
  return (
    <MeProvider me={me.data}>
      <Outlet />
    </MeProvider>
  );
}

/** Signed in, no workspace yet (or creating another). */
function RequireUser() {
  const me = useMe();
  if (me.isLoading)
    return (
      <Centered>
        <Spinner />
      </Centered>
    );
  if (!me.data) return <Navigate to="/login" replace />;
  return <Outlet />;
}

function GuestOnly() {
  const me = useMe();
  if (me.isLoading)
    return (
      <Centered>
        <Spinner />
      </Centered>
    );
  if (me.data) return <Navigate to="/" replace />;
  return <Outlet />;
}

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route element={<GuestOnly />}>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/signup" element={<SignupPage />} />
          </Route>
          <Route element={<RequireUser />}>
            <Route path="/welcome" element={<CreateWorkspacePage />} />
          </Route>
          <Route element={<RequireWorkspace />}>
            <Route element={<AppLayout />}>
              <Route index element={<OverviewPage />} />
              <Route path="models" element={<ModelsPage />} />
              <Route path="knowledge" element={<KnowledgePage />} />
              <Route path="knowledge/:id" element={<KnowledgeBasePage />} />
              <Route
                path="bots"
                element={
                  <ComingSoonPage
                    title="Bots"
                    description="Create chatbots from your knowledge bases, brand them, and embed them on your site or intranet."
                  />
                }
              />
              <Route path="settings" element={<SettingsPage />} />
            </Route>
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
