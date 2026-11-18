import { Answer } from "@lumen/chat-ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Copy, MessageSquarePlus, Send, Square, ThumbsDown, ThumbsUp, Trash2 } from "lucide-react";
import { type FormEvent, type KeyboardEvent, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { Alert, Badge, Button, Card, cx, Modal, PageHeader, Spinner } from "../components/ui";
import {
  api,
  type Bot,
  type ChatSource,
  type Citation,
  type ConversationSummary,
  canEdit,
  canManage,
  type StoredMessage,
  streamChat,
} from "../lib/api";
import { useCurrentMe } from "../lib/session";
import { BotEmbed } from "./BotEmbed";
import { BotForm } from "./Bots";

type Tab = "playground" | "conversations" | "embed";

export function BotPage() {
  const { id = "" } = useParams();
  const me = useCurrentMe();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>("playground");
  const [editing, setEditing] = useState(false);
  const bot = useQuery({ queryKey: ["bot", id], queryFn: () => api<{ bot: Bot }>(`/api/v1/bots/${id}`) });
  const remove = useMutation({
    mutationFn: () => api(`/api/v1/bots/${id}`, { method: "DELETE" }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["bots"] });
      navigate("/bots");
    },
  });

  if (bot.isLoading) return <Spinner />;
  if (bot.error || !bot.data)
    return <Alert tone="danger">{(bot.error as Error)?.message ?? "Not found"}</Alert>;
  const b = bot.data.bot;

  return (
    <>
      <Link to="/bots" className="mb-4 inline-flex items-center gap-1 text-sm text-muted hover:text-fg">
        <ArrowLeft className="size-4" aria-hidden /> Bots
      </Link>
      <PageHeader
        title={b.name}
        description={`${b.llmLabel} · ${b.knowledgeBases.map((k) => k.name).join(", ") || "no knowledge bases"} · ${
          b.grounding === "strict" ? "answers only from documents" : "documents first, then general knowledge"
        }`}
        actions={
          <div className="flex gap-2">
            {canEdit(me.tenant?.role) && (
              <Button variant="secondary" onClick={() => setEditing(true)}>
                Settings
              </Button>
            )}
            {canManage(me.tenant?.role) && (
              <Button
                variant="danger"
                aria-label="Delete bot"
                loading={remove.isPending}
                onClick={() => {
                  if (confirm(`Delete "${b.name}" and its conversation history?`)) remove.mutate();
                }}
              >
                <Trash2 className="size-4" aria-hidden />
              </Button>
            )}
          </div>
        }
      />
      {b.knowledgeBases.length === 0 && (
        <div className="mb-4">
          <Alert tone="info">
            This bot has no knowledge bases yet, so it can't answer from your documents. Add one in Settings.
          </Alert>
        </div>
      )}
      <div role="tablist" className="mb-4 flex gap-1 border-b border-border">
        {(
          [
            ["playground", "Playground"],
            ["conversations", `Conversations (${b.conversationCount})`],
            ["embed", "Embed & branding"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            onClick={() => {
              setTab(key);
              // Website visitors add conversations too, so refresh the counts.
              void qc.invalidateQueries({ queryKey: ["bot", id] });
              void qc.invalidateQueries({ queryKey: ["conversations", id] });
            }}
            className={cx(
              "-mb-px border-b-2 px-3 py-2 text-sm font-medium",
              tab === key ? "border-accent text-accent" : "border-transparent text-muted hover:text-fg",
            )}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === "playground" ? (
        canEdit(me.tenant?.role) ? (
          <Playground bot={b} onTurn={() => qc.invalidateQueries({ queryKey: ["bot", id] })} />
        ) : (
          <Alert tone="info">The playground needs the editor role or higher.</Alert>
        )
      ) : tab === "embed" ? (
        <BotEmbed bot={b} />
      ) : (
        <Conversations botId={b.id} />
      )}
      <Modal open={editing} onClose={() => setEditing(false)} title="Bot settings" wide>
        <BotForm bot={b} onDone={() => setEditing(false)} />
      </Modal>
    </>
  );
}

interface Turn {
  key: string;
  role: "user" | "assistant";
  text: string;
  citations: Citation[];
  status: "streaming" | "complete" | "error" | "stopped";
  error?: string;
  messageId?: string;
  feedback?: "up" | "down" | null;
  sources?: ChatSource[];
  query?: string;
  condensed?: boolean;
  latencyMs?: number;
  usage?: { tokensIn: number; tokensOut: number };
  fallback?: boolean;
  skipped?: { kbId: string; reason: string }[];
}

function Playground({ bot, onTurn }: { bot: Bot; onTurn: () => void }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [conversationId, setConversationId] = useState<string>();
  const [input, setInput] = useState("");
  const [includeStaff, setIncludeStaff] = useState(true);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string>();
  const abortRef = useRef<AbortController | undefined>(undefined);
  const endRef = useRef<HTMLDivElement>(null);

  // Keep the latest message in view as text streams in.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run whenever the transcript changes
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "nearest" });
  }, [turns]);

  const update = (key: string, patch: Partial<Turn> | ((t: Turn) => Partial<Turn>)) =>
    setTurns((ts) =>
      ts.map((t) => (t.key === key ? { ...t, ...(typeof patch === "function" ? patch(t) : patch) } : t)),
    );

  async function send(e?: FormEvent) {
    e?.preventDefault();
    const message = input.trim();
    if (!message || busy) return;
    setInput("");
    setBusy(true);
    const key = crypto.randomUUID();
    setTurns((ts) => [
      ...ts,
      { key: `${key}-q`, role: "user", text: message, citations: [], status: "complete" },
      { key, role: "assistant", text: "", citations: [], status: "streaming" },
    ]);
    setSelected(key);
    const abort = new AbortController();
    abortRef.current = abort;
    try {
      for await (const ev of streamChat(bot.id, { message, conversationId, includeStaff }, abort.signal)) {
        if (ev.type === "meta") setConversationId(ev.conversationId);
        else if (ev.type === "sources")
          update(key, { sources: ev.sources, query: ev.query, condensed: ev.condensed, skipped: ev.skipped });
        else if (ev.type === "delta") update(key, (t) => ({ text: t.text + ev.text }));
        else if (ev.type === "done")
          update(key, {
            status: ev.finishReason === "stopped" ? "stopped" : "complete",
            citations: ev.citations,
            messageId: ev.messageId,
            latencyMs: ev.latencyMs,
            usage: ev.usage,
            fallback: ev.fallback,
          });
        else if (ev.type === "error")
          update(key, { status: "error", error: ev.message, messageId: ev.messageId });
      }
    } catch (err) {
      if (abort.signal.aborted) update(key, { status: "stopped" });
      else update(key, { status: "error", error: (err as Error).message });
    } finally {
      setBusy(false);
      abortRef.current = undefined;
      onTurn();
    }
  }

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  const focus =
    turns.find((t) => t.key === selected && t.role === "assistant") ??
    [...turns].reverse().find((t) => t.role === "assistant");

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
      <Card className="flex min-h-[28rem] flex-col">
        <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2">
          <label className="flex items-center gap-2 text-sm text-muted">
            <input
              type="checkbox"
              className="accent-[var(--accent)]"
              checked={includeStaff}
              onChange={(e) => setIncludeStaff(e.target.checked)}
            />
            Include staff-only documents
          </label>
          <Button
            variant="ghost"
            disabled={busy || turns.length === 0}
            onClick={() => {
              setTurns([]);
              setConversationId(undefined);
              setSelected(undefined);
            }}
          >
            <MessageSquarePlus className="size-4" aria-hidden /> New chat
          </Button>
        </div>
        <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4" aria-live="polite">
          {turns.length === 0 && (
            <p className="py-12 text-center text-sm text-muted">
              Ask a question your customers or staff might ask.
            </p>
          )}
          {turns.map((t) =>
            t.role === "user" ? (
              <div key={t.key} className="flex justify-end">
                <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-accent px-3.5 py-2 text-sm text-accent-fg">
                  {t.text}
                </div>
              </div>
            ) : (
              <AssistantTurn
                key={t.key}
                turn={t}
                selected={focus?.key === t.key}
                onSelect={() => setSelected(t.key)}
              />
            ),
          )}
          <div ref={endRef} />
        </div>
        <form onSubmit={send} className="flex items-end gap-2 border-t border-border p-3">
          <textarea
            aria-label="Message"
            rows={1}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKey}
            placeholder="Ask a question…"
            className="max-h-40 min-h-10 flex-1 resize-y rounded-lg border border-border bg-surface px-3 py-2 text-sm text-fg placeholder:text-muted focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/40"
          />
          {busy ? (
            <Button variant="secondary" onClick={() => abortRef.current?.abort()} aria-label="Stop">
              <Square className="size-4" aria-hidden /> Stop
            </Button>
          ) : (
            <Button type="submit" disabled={!input.trim()} aria-label="Send">
              <Send className="size-4" aria-hidden /> Send
            </Button>
          )}
        </form>
      </Card>
      <WhatTheBotSaw turn={focus} />
    </div>
  );
}

function AssistantTurn({
  turn,
  selected,
  onSelect,
}: {
  turn: Turn;
  selected: boolean;
  onSelect: () => void;
}) {
  const [feedback, setFeedback] = useState(turn.feedback ?? null);
  const rate = useMutation({
    mutationFn: (value: "up" | "down" | null) =>
      api(`/api/v1/messages/${turn.messageId}/feedback`, { body: { feedback: value } }),
    onSuccess: (_d, value) => setFeedback(value),
  });
  return (
    <div className="flex">
      {/* biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/noStaticElementInteractions: selecting a turn is a convenience; the panel is also reachable by focus */}
      <div
        onClick={onSelect}
        className={cx(
          "max-w-[92%] rounded-2xl rounded-bl-sm border bg-surface px-3.5 py-2.5",
          selected ? "border-accent" : "border-border",
        )}
      >
        {turn.text ? (
          <Answer text={turn.text} citations={turn.citations} streaming={turn.status === "streaming"} />
        ) : turn.status === "streaming" ? (
          <Spinner label={turn.sources ? "Writing" : "Searching your documents"} />
        ) : null}
        {turn.status === "error" && <p className="mt-2 text-sm text-danger">{turn.error}</p>}
        {turn.status === "stopped" && <p className="mt-2 text-xs text-muted">Stopped.</p>}
        {turn.messageId && turn.status !== "streaming" && (
          <div className="mt-2 flex items-center gap-1 text-muted">
            {turn.fallback && <Badge>No matching documents</Badge>}
            <button
              type="button"
              aria-label="Copy answer"
              className="rounded p-1 hover:bg-surface-2 hover:text-fg"
              onClick={() => navigator.clipboard?.writeText(turn.text)}
            >
              <Copy className="size-3.5" aria-hidden />
            </button>
            <button
              type="button"
              aria-label="Good answer"
              aria-pressed={feedback === "up"}
              className={cx(
                "rounded p-1 hover:bg-surface-2",
                feedback === "up" ? "text-ok" : "hover:text-fg",
              )}
              onClick={() => rate.mutate(feedback === "up" ? null : "up")}
            >
              <ThumbsUp className="size-3.5" aria-hidden />
            </button>
            <button
              type="button"
              aria-label="Bad answer"
              aria-pressed={feedback === "down"}
              className={cx(
                "rounded p-1 hover:bg-surface-2",
                feedback === "down" ? "text-danger" : "hover:text-fg",
              )}
              onClick={() => rate.mutate(feedback === "down" ? null : "down")}
            >
              <ThumbsDown className="size-3.5" aria-hidden />
            </button>
            {turn.latencyMs !== undefined && (
              <span className="ml-1 text-xs">{(turn.latencyMs / 1000).toFixed(1)} s</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function WhatTheBotSaw({ turn }: { turn?: Turn }) {
  return (
    <Card className="h-fit p-4 lg:sticky lg:top-6">
      <h2 className="text-sm font-semibold">What the bot saw</h2>
      {!turn ? (
        <p className="mt-2 text-sm text-muted">
          Ask something to see which passages the bot retrieved and used.
        </p>
      ) : !turn.sources ? (
        <div className="mt-3">
          <Spinner label="Searching" />
        </div>
      ) : (
        <div className="mt-3 flex flex-col gap-3 text-sm">
          <div>
            <p className="text-xs text-muted">
              {turn.condensed ? "Searched for (rewritten from your follow-up)" : "Searched for"}
            </p>
            <p className="font-medium">{turn.query}</p>
          </div>
          {turn.skipped && turn.skipped.length > 0 && (
            <Alert tone="danger">{turn.skipped.map((s) => s.reason).join(" ")}</Alert>
          )}
          <div>
            <p className="mb-1 text-xs text-muted">{turn.sources.length} passages retrieved</p>
            <ol className="flex flex-col gap-2">
              {turn.sources.map((s) => {
                const cited = turn.citations.some((c) => c.n === s.n);
                return (
                  <li
                    key={s.chunkId}
                    className={cx("rounded-lg border p-2", cited ? "border-accent" : "border-border")}
                  >
                    <div className="flex flex-wrap items-center gap-1.5 text-xs">
                      <span className="font-semibold text-accent">[{s.n}]</span>
                      <span className="font-medium">{s.title}</span>
                      {cited && <Badge tone="accent">Cited</Badge>}
                      {s.audience === "staff" && <Badge>Staff</Badge>}
                    </div>
                    <p className="mt-1 line-clamp-3 text-xs text-muted">{s.text}</p>
                    <p className="mt-1 text-[11px] text-muted">
                      {s.via.includes("vector") ? `${Math.round(s.score * 100)}% match` : "keyword match"}
                      {s.via.length > 1 ? " · vector + keyword" : ""}
                    </p>
                  </li>
                );
              })}
            </ol>
          </div>
          {turn.usage && (
            <p className="text-xs text-muted">
              {turn.usage.tokensIn.toLocaleString()} tokens in · {turn.usage.tokensOut.toLocaleString()} out
              {turn.latencyMs !== undefined ? ` · ${(turn.latencyMs / 1000).toFixed(1)} s` : ""}
            </p>
          )}
        </div>
      )}
    </Card>
  );
}

function Conversations({ botId }: { botId: string }) {
  const [open, setOpen] = useState<string>();
  const list = useQuery({
    queryKey: ["conversations", botId],
    queryFn: () => api<{ conversations: ConversationSummary[] }>(`/api/v1/bots/${botId}/conversations`),
  });
  if (list.isLoading) return <Spinner />;
  const items = list.data?.conversations ?? [];
  if (items.length === 0)
    return <Card className="border-dashed p-6 text-center text-sm text-muted">No conversations yet.</Card>;
  return (
    <>
      <Card>
        <ul className="divide-y divide-border">
          {items.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => setOpen(c.id)}
                className="flex w-full items-center gap-3 px-5 py-3 text-left hover:bg-surface-2"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{c.title || "Untitled conversation"}</span>
                  <span className="text-xs text-muted">
                    {new Date(c.updatedAt).toLocaleString()} · {c.messageCount} messages
                  </span>
                </span>
                <Badge>{c.channel}</Badge>
              </button>
            </li>
          ))}
        </ul>
      </Card>
      <Modal open={open !== undefined} onClose={() => setOpen(undefined)} title="Conversation" wide>
        {open && <Transcript conversationId={open} />}
      </Modal>
    </>
  );
}

function Transcript({ conversationId }: { conversationId: string }) {
  const convo = useQuery({
    queryKey: ["conversation", conversationId],
    queryFn: () => api<{ messages: StoredMessage[] }>(`/api/v1/conversations/${conversationId}`),
  });
  if (convo.isLoading) return <Spinner />;
  return (
    <div className="flex flex-col gap-3">
      {(convo.data?.messages ?? []).map((m) =>
        m.role === "user" ? (
          <div key={m.id} className="flex justify-end">
            <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-accent px-3.5 py-2 text-sm text-accent-fg">
              {m.content}
            </div>
          </div>
        ) : (
          <div key={m.id} className="rounded-2xl rounded-bl-sm border border-border px-3.5 py-2.5">
            <Answer text={m.content} citations={m.citations} />
            {m.status === "error" && <p className="mt-1 text-sm text-danger">{m.error}</p>}
            <p className="mt-2 text-xs text-muted">
              {m.retrieval
                ? `Searched for "${m.retrieval.query}" · ${m.retrieval.sources.length} passages`
                : ""}
              {m.feedback ? ` · rated ${m.feedback === "up" ? "👍" : "👎"}` : ""}
            </p>
          </div>
        ),
      )}
    </div>
  );
}
