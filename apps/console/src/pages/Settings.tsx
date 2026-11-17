import { useQuery } from "@tanstack/react-query";
import { Badge, Card, PageHeader, Spinner } from "../components/ui";
import { authClient } from "../lib/auth";
import { useCurrentMe } from "../lib/session";

export function SettingsPage() {
  const me = useCurrentMe();
  const org = useQuery({
    queryKey: ["organization", me.tenant?.id],
    queryFn: async () => {
      const { data, error } = await authClient.organization.getFullOrganization();
      if (error) throw new Error(error.message);
      return data;
    },
  });

  return (
    <>
      <PageHeader title="Settings" description="Workspace details and team members." />
      <Card className="mb-6 p-5">
        <dl className="grid gap-4 sm:grid-cols-3">
          <div>
            <dt className="text-xs text-muted">Workspace</dt>
            <dd className="font-medium">{me.tenant?.name}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted">Workspace ID</dt>
            <dd className="font-mono text-xs">{me.tenant?.id}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted">Your role</dt>
            <dd className="capitalize">{me.tenant?.role}</dd>
          </div>
        </dl>
      </Card>
      <h2 className="mb-3 font-semibold">Members</h2>
      {org.isLoading && <Spinner />}
      {org.data && (
        <Card>
          <ul className="divide-y divide-border">
            {org.data.members.map((m) => (
              <li key={m.id} className="flex items-center justify-between gap-4 px-5 py-3">
                <div className="min-w-0">
                  <div className="truncate font-medium">{m.user.name || m.user.email}</div>
                  <div className="truncate text-sm text-muted">{m.user.email}</div>
                </div>
                <Badge tone={m.role === "owner" ? "accent" : "neutral"}>{m.role}</Badge>
              </li>
            ))}
          </ul>
        </Card>
      )}
      <p className="mt-3 text-sm text-muted">Inviting teammates arrives in a later release.</p>
    </>
  );
}
