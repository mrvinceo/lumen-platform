import { useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { Link, useNavigate } from "react-router";
import { Alert, Button, Card, Field, Input, Logo } from "../components/ui";
import { authClient } from "../lib/auth";
import { useMe } from "../lib/session";

function AuthShell({
  title,
  children,
  footer,
}: {
  title: string;
  children: React.ReactNode;
  footer: React.ReactNode;
}) {
  return (
    <div className="flex min-h-full items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex justify-center">
          <Logo />
        </div>
        <Card className="p-6">
          <h1 className="mb-5 text-lg font-semibold">{title}</h1>
          {children}
        </Card>
        <p className="mt-4 text-center text-sm text-muted">{footer}</p>
      </div>
    </div>
  );
}

export function LoginPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    const { error } = await authClient.signIn.email({ email, password });
    setBusy(false);
    if (error) return setError(error.message ?? "Could not sign in.");
    await qc.invalidateQueries({ queryKey: ["me"] });
    navigate("/");
  }

  return (
    <AuthShell
      title="Sign in"
      footer={
        <>
          New to Lumen?{" "}
          <Link to="/signup" className="font-medium text-accent hover:underline">
            Create an account
          </Link>
        </>
      }
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="Email" htmlFor="email">
          <Input
            id="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>
        <Field label="Password" htmlFor="password">
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        {error && <Alert tone="danger">{error}</Alert>}
        <Button type="submit" loading={busy}>
          Sign in
        </Button>
      </form>
    </AuthShell>
  );
}

export function SignupPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    const { error } = await authClient.signUp.email({ name, email, password });
    setBusy(false);
    if (error) return setError(error.message ?? "Could not create the account.");
    await qc.invalidateQueries({ queryKey: ["me"] });
    navigate("/welcome");
  }

  return (
    <AuthShell
      title="Create your account"
      footer={
        <>
          Already have an account?{" "}
          <Link to="/login" className="font-medium text-accent hover:underline">
            Sign in
          </Link>
        </>
      }
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="Your name" htmlFor="name">
          <Input
            id="name"
            autoComplete="name"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field label="Work email" htmlFor="email">
          <Input
            id="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>
        <Field label="Password" htmlFor="password" hint="At least 10 characters.">
          <Input
            id="password"
            type="password"
            autoComplete="new-password"
            minLength={10}
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        {error && <Alert tone="danger">{error}</Alert>}
        <Button type="submit" loading={busy}>
          Create account
        </Button>
      </form>
    </AuthShell>
  );
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

export function CreateWorkspacePage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const me = useMe();
  const [name, setName] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [opening, setOpening] = useState<string>();
  const existing = me.data?.tenants ?? [];
  const canCreate = me.data?.canCreateWorkspace ?? true;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    const base = slugify(name) || "workspace";
    const slug = `${base}-${Math.random().toString(36).slice(2, 6)}`;
    const { error } = await authClient.organization.create({ name, slug });
    setBusy(false);
    if (error) return setError(error.message ?? "Could not create the workspace.");
    await qc.invalidateQueries();
    navigate("/");
  }

  async function open(tenantId: string) {
    setOpening(tenantId);
    setError(undefined);
    const { error } = await authClient.organization.setActive({ organizationId: tenantId });
    setOpening(undefined);
    if (error) return setError(error.message ?? "Could not open the workspace.");
    await qc.invalidateQueries();
    navigate("/");
  }

  return (
    <AuthShell
      title={
        existing.length > 0 ? "Choose a workspace" : canCreate ? "Create your workspace" : "No workspace yet"
      }
      footer="A workspace holds your models, knowledge bases and bots. You can invite teammates later."
    >
      <div className="flex flex-col gap-5">
        {existing.length > 0 && (
          <ul className="flex flex-col gap-2" aria-label="Your workspaces">
            {existing.map((t) => (
              <li
                key={t.id}
                className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2"
              >
                <span className="min-w-0 truncate text-sm font-medium">{t.name}</span>
                <Button variant="secondary" loading={opening === t.id} onClick={() => open(t.id)}>
                  Open
                </Button>
              </li>
            ))}
          </ul>
        )}
        {canCreate ? (
          <form onSubmit={submit} className="flex flex-col gap-4">
            {existing.length > 0 && <h2 className="text-sm font-medium">Or create a new workspace</h2>}
            <Field label="Company or team name" htmlFor="ws">
              <Input
                id="ws"
                required
                maxLength={80}
                placeholder="Acme Ltd"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            <Button type="submit" loading={busy}>
              Create workspace
            </Button>
          </form>
        ) : (
          existing.length === 0 && (
            <Alert tone="info">
              New workspaces are turned off on this server. Ask an administrator to invite you to theirs.
            </Alert>
          )
        )}
        {error && <Alert tone="danger">{error}</Alert>}
      </div>
    </AuthShell>
  );
}
