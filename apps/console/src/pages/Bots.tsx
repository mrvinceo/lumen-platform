import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot as BotIcon, Plus } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Link, useNavigate } from "react-router";
import {
  Alert,
  Badge,
  Button,
  Card,
  cx,
  Field,
  Input,
  Modal,
  PageHeader,
  Select,
  Spinner,
} from "../components/ui";
import { api, type Bot, canEdit, type KnowledgeBase, type ProviderConfig } from "../lib/api";
import { useCurrentMe } from "../lib/session";

export function BotsPage() {
  const me = useCurrentMe();
  const edit = canEdit(me.tenant?.role);
  const [creating, setCreating] = useState(false);
  const bots = useQuery({ queryKey: ["bots"], queryFn: () => api<{ bots: Bot[] }>("/api/v1/bots") });
  const list = bots.data?.bots ?? [];

  return (
    <>
      <PageHeader
        title="Bots"
        description="A bot answers questions from your knowledge bases using one of your chat models. Test it in the playground before you embed it."
        actions={
          edit && (
            <Button onClick={() => setCreating(true)}>
              <Plus className="size-4" aria-hidden /> New bot
            </Button>
          )
        }
      />
      {bots.isLoading && <Spinner />}
      {bots.error && <Alert tone="danger">{(bots.error as Error).message}</Alert>}
      {bots.data && list.length === 0 && (
        <Card className="border-dashed p-8 text-center">
          <BotIcon className="mx-auto size-8 text-muted" aria-hidden />
          <p className="mt-3 font-medium">No bots yet</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted">
            {edit
              ? "Create one, pick its knowledge bases and chat model, then try it out in the playground."
              : "Ask an editor to create one."}
          </p>
        </Card>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        {list.map((b) => (
          <Link key={b.id} to={`/bots/${b.id}`} className="block">
            <Card className="h-full p-5 transition hover:border-accent">
              <div className="flex items-start justify-between gap-3">
                <h2 className="font-semibold">{b.name}</h2>
                <Badge tone={b.grounding === "strict" ? "accent" : "neutral"}>
                  {b.grounding === "strict" ? "Documents only" : "Documents first"}
                </Badge>
              </div>
              <dl className="mt-3 grid gap-2 text-sm">
                <div className="min-w-0">
                  <dt className="text-xs text-muted">Knowledge</dt>
                  <dd className="truncate">
                    {b.knowledgeBases.map((k) => k.name).join(", ") || "None selected"}
                  </dd>
                </div>
                <div className="min-w-0">
                  <dt className="text-xs text-muted">Chat model</dt>
                  <dd className="truncate">{b.llmLabel}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted">Conversations</dt>
                  <dd>{b.conversationCount}</dd>
                </div>
              </dl>
            </Card>
          </Link>
        ))}
      </div>
      <Modal open={creating} onClose={() => setCreating(false)} title="New bot" wide>
        <BotForm onDone={() => setCreating(false)} />
      </Modal>
    </>
  );
}

/** Create (no `bot`) or edit a bot. */
export function BotForm({ bot, onDone }: { bot?: Bot; onDone: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const models = useQuery({
    queryKey: ["providers"],
    queryFn: () => api<{ providers: ProviderConfig[] }>("/api/v1/providers"),
  });
  const kbs = useQuery({
    queryKey: ["knowledge-bases"],
    queryFn: () => api<{ knowledgeBases: KnowledgeBase[] }>("/api/v1/knowledge-bases"),
  });
  const chatModels = (models.data?.providers ?? []).filter((p) => p.type === "llm");

  const [name, setName] = useState(bot?.name ?? "");
  const [kbIds, setKbIds] = useState<string[]>(bot?.kbIds ?? []);
  const [llmConfigId, setLlmConfigId] = useState<string | undefined>(bot?.llmConfigId);
  const [systemPrompt, setSystemPrompt] = useState(bot?.systemPrompt ?? "");
  const [grounding, setGrounding] = useState<"strict" | "lenient">(bot?.grounding ?? "strict");
  const [fallbackMessage, setFallbackMessage] = useState(bot?.fallbackMessage ?? "");
  const [topK, setTopK] = useState(bot?.topK ?? 6);
  const [error, setError] = useState<string>();
  const modelId = llmConfigId ?? chatModels[0]?.id;

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: name.trim(),
        kbIds,
        llmConfigId: modelId,
        ...(bot || systemPrompt.trim() ? { systemPrompt } : {}),
        grounding,
        ...(bot || fallbackMessage.trim() ? { fallbackMessage } : {}),
        topK,
      };
      return bot
        ? api<{ bot: Bot }>(`/api/v1/bots/${bot.id}`, { method: "PATCH", body })
        : api<{ bot: Bot }>("/api/v1/bots", { body });
    },
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: ["bots"] });
      await qc.invalidateQueries({ queryKey: ["bot", r.bot.id] });
      onDone();
      if (!bot) navigate(`/bots/${r.bot.id}`);
    },
    onError: (e) => setError((e as Error).message),
  });

  if (models.isLoading || kbs.isLoading) return <Spinner />;
  if (chatModels.length === 0) {
    return (
      <Alert tone="info">
        Add a chat model on the{" "}
        <Link to="/models" className="font-medium underline">
          Models page
        </Link>{" "}
        first.
      </Alert>
    );
  }

  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        setError(undefined);
        save.mutate();
      }}
    >
      <Field label="Name" htmlFor="bot-name">
        <Input
          id="bot-name"
          required
          maxLength={100}
          placeholder="Customer support"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </Field>
      <fieldset>
        <legend className="mb-2 text-sm font-medium">Knowledge bases</legend>
        {(kbs.data?.knowledgeBases ?? []).length === 0 ? (
          <p className="text-sm text-muted">
            No knowledge bases yet.{" "}
            <Link to="/knowledge" className="text-accent hover:underline">
              Create one
            </Link>{" "}
            so the bot has something to answer from.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {(kbs.data?.knowledgeBases ?? []).map((k) => (
              <label
                key={k.id}
                className={cx(
                  "flex items-center gap-3 rounded-lg border px-3 py-2 text-sm",
                  kbIds.includes(k.id) ? "border-accent bg-accent-soft" : "border-border",
                )}
              >
                <input
                  type="checkbox"
                  className="accent-[var(--accent)]"
                  checked={kbIds.includes(k.id)}
                  onChange={(e) =>
                    setKbIds((ids) => (e.target.checked ? [...ids, k.id] : ids.filter((x) => x !== k.id)))
                  }
                />
                <span className="flex-1">{k.name}</span>
                <span className="text-xs text-muted">{k.indexedCount} documents</span>
              </label>
            ))}
          </div>
        )}
      </fieldset>
      <Field label="Chat model" htmlFor="bot-model">
        <Select id="bot-model" value={modelId} onChange={(e) => setLlmConfigId(e.target.value)}>
          {chatModels.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </Select>
      </Field>
      <Field
        label="Instructions"
        htmlFor="bot-prompt"
        hint={
          bot
            ? "The bot's persona and any house rules: tone, what to cover, what to avoid."
            : "Leave empty for a sensible default; you can refine it later."
        }
      >
        <textarea
          id="bot-prompt"
          rows={5}
          maxLength={8000}
          value={systemPrompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
          placeholder="You are the helpful assistant for Acme. Be friendly and concise. For billing questions, point people to billing@acme.com."
          className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-fg placeholder:text-muted focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/40"
        />
      </Field>
      <fieldset>
        <legend className="mb-2 text-sm font-medium">When the documents don't have the answer</legend>
        {(
          [
            [
              "strict",
              "Say it doesn't know",
              "Only answers from your documents. Best for customer-facing bots.",
            ],
            [
              "lenient",
              "Use general knowledge, and say so",
              "Answers from documents first, then from the model's own knowledge, flagged as such.",
            ],
          ] as const
        ).map(([value, title, body]) => (
          <label
            key={value}
            className={cx(
              "mb-2 flex items-start gap-3 rounded-lg border px-3 py-2.5 text-sm",
              grounding === value ? "border-accent bg-accent-soft" : "border-border",
            )}
          >
            <input
              type="radio"
              name="grounding"
              className="mt-0.5 accent-[var(--accent)]"
              checked={grounding === value}
              onChange={() => setGrounding(value)}
            />
            <span>
              <span className="block font-medium">{title}</span>
              <span className="text-muted">{body}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {grounding === "strict" && (
        <Field label="Reply when it can't find an answer" htmlFor="bot-fallback">
          <Input
            id="bot-fallback"
            maxLength={500}
            placeholder="I couldn't find that in our documentation."
            value={fallbackMessage}
            onChange={(e) => setFallbackMessage(e.target.value)}
          />
        </Field>
      )}
      <Field
        label="Passages per answer"
        htmlFor="bot-topk"
        hint="How many document passages the bot reads before answering (1–20)."
      >
        <Input
          id="bot-topk"
          type="number"
          min={1}
          max={20}
          value={topK}
          onChange={(e) => setTopK(Number(e.target.value))}
          className="w-24"
        />
      </Field>
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="flex justify-end gap-2 border-t border-border pt-4">
        <Button variant="secondary" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" loading={save.isPending} disabled={!name.trim() || !modelId}>
          {bot ? "Save changes" : "Create bot"}
        </Button>
      </div>
    </form>
  );
}
