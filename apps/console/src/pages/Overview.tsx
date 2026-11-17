import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, Circle } from "lucide-react";
import { Link } from "react-router";
import { Badge, Card, PageHeader } from "../components/ui";
import { api, type ProviderConfig } from "../lib/api";
import { useCurrentMe } from "../lib/session";

export function OverviewPage() {
  const me = useCurrentMe();
  const providers = useQuery({
    queryKey: ["providers"],
    queryFn: () => api<{ providers: ProviderConfig[] }>("/api/v1/providers"),
  });
  const list = providers.data?.providers ?? [];
  const steps = [
    {
      done: list.some((p) => p.type === "llm"),
      title: "Connect a chat model",
      body: "The model that writes answers, using your own API key.",
      to: "/models",
      phase: null,
    },
    {
      done: list.some((p) => p.type === "embedding"),
      title: "Connect an embedding model",
      body: "Turns your documents into vectors for search.",
      to: "/models",
      phase: null,
    },
    {
      done: false,
      title: "Create a knowledge base",
      body: "Upload files or connect Google Drive or OneDrive.",
      to: "/knowledge",
      phase: "Coming next",
    },
    {
      done: false,
      title: "Build and embed a bot",
      body: "Brand it, test it, and paste one line of code into your site.",
      to: "/bots",
      phase: "Coming soon",
    },
  ];

  return (
    <>
      <PageHeader
        title={`Welcome${me.user.name ? `, ${me.user.name.split(" ")[0]}` : ""}`}
        description={`Get ${me.tenant?.name} from documents to a working chatbot in four steps.`}
      />
      <Card>
        <ol className="divide-y divide-border">
          {steps.map((s, i) => (
            <li key={s.title}>
              <Link to={s.to} className="flex items-start gap-4 px-5 py-4 transition hover:bg-surface-2">
                {s.done ? (
                  <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-ok" aria-label="Done" />
                ) : (
                  <Circle className="mt-0.5 size-5 shrink-0 text-muted" aria-label="Not done" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2 font-medium">
                    {i + 1}. {s.title}
                    {s.phase && <Badge>{s.phase}</Badge>}
                  </div>
                  <p className="mt-0.5 text-sm text-muted">{s.body}</p>
                </div>
              </Link>
            </li>
          ))}
        </ol>
      </Card>
    </>
  );
}

export function ComingSoonPage({ title, description }: { title: string; description: string }) {
  return (
    <>
      <PageHeader title={title} />
      <Card className="p-8 text-center">
        <Badge tone="accent">Coming soon</Badge>
        <p className="mx-auto mt-3 max-w-md text-sm text-muted">{description}</p>
      </Card>
    </>
  );
}
