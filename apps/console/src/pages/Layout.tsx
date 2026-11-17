import { useQueryClient } from "@tanstack/react-query";
import { BookOpen, Bot, Cpu, Gauge, LogOut, Settings } from "lucide-react";
import { NavLink, Outlet, useNavigate } from "react-router";
import { cx, Logo, Select } from "../components/ui";
import { authClient } from "../lib/auth";
import { useCurrentMe } from "../lib/session";

const NAV = [
  { to: "/", label: "Overview", icon: Gauge, end: true },
  { to: "/models", label: "Models", icon: Cpu },
  { to: "/knowledge", label: "Knowledge", icon: BookOpen },
  { to: "/bots", label: "Bots", icon: Bot },
  { to: "/settings", label: "Settings", icon: Settings },
];

export function AppLayout() {
  const me = useCurrentMe();
  const qc = useQueryClient();
  const navigate = useNavigate();

  async function switchTenant(id: string) {
    await authClient.organization.setActive({ organizationId: id });
    await qc.invalidateQueries();
  }

  async function signOut() {
    await authClient.signOut();
    qc.clear();
    navigate("/login");
  }

  return (
    <div className="flex min-h-full flex-col md:flex-row">
      <aside className="flex shrink-0 flex-col gap-4 border-b border-border bg-surface px-3 py-4 md:w-60 md:border-r md:border-b-0">
        <div className="px-2">
          <Logo />
        </div>
        {me.tenants.length > 1 ? (
          <Select aria-label="Workspace" value={me.tenant?.id} onChange={(e) => switchTenant(e.target.value)}>
            {me.tenants.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        ) : (
          <div className="truncate rounded-lg bg-surface-2 px-3 py-2 text-sm font-medium">
            {me.tenant?.name}
          </div>
        )}
        <nav className="flex gap-1 overflow-x-auto md:flex-col">
          {NAV.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                cx(
                  "flex items-center gap-2.5 whitespace-nowrap rounded-lg px-3 py-2 text-sm font-medium transition",
                  isActive ? "bg-accent-soft text-accent" : "text-muted hover:bg-surface-2 hover:text-fg",
                )
              }
            >
              <Icon className="size-4" aria-hidden />
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="flex items-center justify-between gap-2 border-t border-border pt-3 md:mt-auto md:block">
          <div className="min-w-0 px-2 text-sm">
            <div className="truncate font-medium">{me.user.name ?? me.user.email}</div>
            <div className="truncate text-xs text-muted">
              {me.user.email} · {me.tenant?.role}
            </div>
          </div>
          <button
            type="button"
            onClick={signOut}
            className="flex shrink-0 items-center gap-2 rounded-lg px-2 py-2 text-sm text-muted hover:bg-surface-2 hover:text-fg md:mt-2 md:w-full"
          >
            <LogOut className="size-4" aria-hidden /> Sign out
          </button>
        </div>
      </aside>
      <main className="min-w-0 flex-1 px-4 py-6 md:px-10 md:py-8">
        <div className="mx-auto max-w-5xl">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
