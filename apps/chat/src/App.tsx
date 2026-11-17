import { Answer, type Citation, cx, StreamError } from "@lumen/chat-ui";
import { MessageSquarePlus, Send, Square, ThumbsDown, ThumbsUp, X } from "lucide-react";
import { type FormEvent, type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { accentPalette, type Channel, type PublicClient, type PublicConfig, postToHost } from "./api";

interface Turn {
  key: string;
  role: "user" | "assistant";
  text: string;
  citations: Citation[];
  status: "streaming" | "complete" | "error" | "stopped";
  messageId?: string;
  feedback?: "up" | "down" | null;
  error?: string;
}

const uid = () => Math.random().toString(36).slice(2);

export function App({ client, channel }: { client: PublicClient; channel: Channel }) {
  const [config, setConfig] = useState<PublicConfig>();
  const [fatal, setFatal] = useState<string>();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [conversationId, setConversationId] = useState<string | undefined>(() => client.savedConversation());
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  const abortRef = useRef<AbortController | undefined>(undefined);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const visible = useRef(channel === "hosted");

  // Load config, apply branding, restore the previous conversation.
  useEffect(() => {
    client
      .config()
      .then(async (cfg) => {
        setConfig(cfg);
        document.title = cfg.branding.title;
        const saved = client.savedConversation();
        if (saved) {
          try {
            const msgs = await client.history(saved);
            setTurns(
              msgs.map((m) => ({
                key: m.id,
                role: m.role,
                text: m.content,
                citations: m.citations,
                status: m.status === "complete" ? "complete" : m.status,
                messageId: m.role === "assistant" ? m.id : undefined,
                feedback: m.feedback,
              })),
            );
          } catch {
            client.saveConversation(undefined);
            setConversationId(undefined);
          }
        }
        postToHost({ type: "lumen:ready" });
      })
      .catch((err: Error) => setFatal(err.message));
  }, [client]);

  // The loader tells us when the panel opens or closes (for the unread badge and focus).
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== window.parent || (e.data as { type?: string })?.type !== "lumen:visibility") return;
      visible.current = Boolean((e.data as { open?: boolean }).open);
      if (visible.current) inputRef.current?.focus();
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const theme = useMemo(() => {
    if (!config) return "light";
    if (config.branding.theme !== "auto") return config.branding.theme;
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }, [config]);

  useEffect(() => {
    if (!config) return;
    const p = accentPalette(config.branding.primaryColor, theme === "dark");
    const root = document.documentElement;
    root.dataset.theme = theme;
    root.style.setProperty("--accent", p.accent);
    root.style.setProperty("--accent-fg", p.fg);
    root.style.setProperty("--accent-soft", p.soft);
  }, [config, theme]);

  // Keep the newest message in view while text streams in.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run whenever the transcript changes
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "nearest" });
  }, [turns]);

  const update = (key: string, patch: Partial<Turn> | ((t: Turn) => Partial<Turn>)) =>
    setTurns((ts) =>
      ts.map((t) => (t.key === key ? { ...t, ...(typeof patch === "function" ? patch(t) : patch) } : t)),
    );

  function newConversation() {
    abortRef.current?.abort();
    client.saveConversation(undefined);
    setConversationId(undefined);
    setTurns([]);
    setNotice(undefined);
    inputRef.current?.focus();
  }

  async function ask(text: string) {
    const message = text.trim();
    if (!message || busy) return;
    setInput("");
    setNotice(undefined);
    setBusy(true);
    const key = uid();
    setTurns((ts) => [
      ...ts,
      { key: `${key}-q`, role: "user", text: message, citations: [], status: "complete" },
      { key, role: "assistant", text: "", citations: [], status: "streaming" },
    ]);
    const abort = new AbortController();
    abortRef.current = abort;
    try {
      const events = await client.chat(message, conversationId, abort.signal);
      for await (const ev of events) {
        if (ev.type === "meta") {
          setConversationId(ev.conversationId);
          client.saveConversation(ev.conversationId);
        } else if (ev.type === "delta") update(key, (t) => ({ text: t.text + ev.text }));
        else if (ev.type === "done") {
          update(key, {
            status: ev.finishReason === "stopped" ? "stopped" : "complete",
            citations: ev.citations,
            messageId: ev.messageId,
          });
          if (!visible.current) postToHost({ type: "lumen:unread" });
        } else if (ev.type === "error")
          update(key, { status: "error", error: ev.message, messageId: ev.messageId });
      }
    } catch (err) {
      if (abort.signal.aborted) {
        update(key, { status: "stopped" });
      } else if (err instanceof StreamError && err.code === "conversation_full") {
        setTurns((ts) => ts.filter((t) => t.key !== key && t.key !== `${key}-q`));
        setInput(message);
        setNotice(err.message);
      } else if (err instanceof StreamError && err.status === 404) {
        // The saved conversation is gone (or belonged to an expired visitor): start afresh and retry once.
        client.saveConversation(undefined);
        setConversationId(undefined);
        update(key, { status: "error", error: "That conversation has ended. Please ask again." });
      } else {
        update(key, { status: "error", error: (err as Error).message });
      }
    } finally {
      setBusy(false);
      abortRef.current = undefined;
    }
  }

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void ask(input);
    }
  };

  if (fatal) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted">
        <p>{fatal}</p>
      </div>
    );
  }
  if (!config) {
    return <div className="flex h-full items-center justify-center text-sm text-muted">Loading…</div>;
  }

  const b = config.branding;
  return (
    <div
      className={cx(
        "flex h-full flex-col bg-bg",
        channel === "hosted" && "mx-auto max-w-3xl sm:border-x sm:border-border",
      )}
    >
      <header className="flex items-center gap-3 bg-accent px-4 py-3 text-accent-fg">
        {b.logoUrl ? (
          <img src={b.logoUrl} alt="" className="size-8 rounded-full bg-white object-contain" />
        ) : (
          <span
            aria-hidden
            className="flex size-8 items-center justify-center rounded-full bg-white/20 font-semibold"
          >
            {b.title.slice(0, 1).toUpperCase()}
          </span>
        )}
        <h1 className="min-w-0 flex-1 truncate text-base font-semibold">{b.title}</h1>
        <button
          type="button"
          onClick={newConversation}
          disabled={turns.length === 0}
          className="rounded-md p-1.5 hover:bg-white/15 disabled:opacity-40"
          aria-label="New conversation"
          title="New conversation"
        >
          <MessageSquarePlus className="size-5" aria-hidden />
        </button>
        {channel === "widget" && (
          <button
            type="button"
            onClick={() => postToHost({ type: "lumen:close" })}
            className="rounded-md p-1.5 hover:bg-white/15"
            aria-label="Close chat"
          >
            <X className="size-5" aria-hidden />
          </button>
        )}
      </header>

      <main className="flex-1 space-y-3 overflow-y-auto px-4 py-4" aria-live="polite">
        <div className="max-w-[90%] rounded-2xl rounded-bl-sm bg-surface-2 px-3.5 py-2.5 text-sm">
          {b.greeting}
        </div>
        {turns.length === 0 && b.suggestedQuestions.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {b.suggestedQuestions.map((q) => (
              <button
                key={q}
                type="button"
                onClick={() => void ask(q)}
                className="rounded-full border border-accent px-3 py-1.5 text-left text-sm text-fg hover:bg-accent-soft"
              >
                {q}
              </button>
            ))}
          </div>
        )}
        {!config.ready && (
          <p className="text-sm text-muted">
            This assistant is still being set up, so it may not be able to answer yet.
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
            <AssistantBubble
              key={t.key}
              turn={t}
              onRate={(v) =>
                t.messageId && client.feedback(t.messageId, v).then(() => update(t.key, { feedback: v }))
              }
            />
          ),
        )}
        {notice && (
          <div className="rounded-lg bg-surface-2 p-3 text-sm">
            {notice}{" "}
            <button type="button" className="font-medium text-accent underline" onClick={newConversation}>
              Start a new conversation
            </button>
          </div>
        )}
        <div ref={endRef} />
      </main>

      <form
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          void ask(input);
        }}
        className="flex items-end gap-2 border-t border-border p-3"
      >
        <textarea
          ref={inputRef}
          aria-label="Your message"
          rows={1}
          maxLength={2000}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKey}
          placeholder="Type your question…"
          className="max-h-32 min-h-10 flex-1 resize-none rounded-xl border border-border bg-surface px-3 py-2 text-sm text-fg placeholder:text-muted focus:border-accent focus:outline-none"
        />
        {busy ? (
          <button
            type="button"
            onClick={() => abortRef.current?.abort()}
            aria-label="Stop"
            className="flex size-10 items-center justify-center rounded-xl border border-border text-fg"
          >
            <Square className="size-4" aria-hidden />
          </button>
        ) : (
          <button
            type="submit"
            disabled={!input.trim()}
            aria-label="Send"
            className="flex size-10 items-center justify-center rounded-xl bg-accent text-accent-fg disabled:opacity-40"
          >
            <Send className="size-4" aria-hidden />
          </button>
        )}
      </form>
      <p className="pb-2 text-center text-[11px] text-muted">
        AI answers can be wrong. Check important details.
      </p>
    </div>
  );
}

function AssistantBubble({ turn, onRate }: { turn: Turn; onRate: (v: "up" | "down" | null) => void }) {
  return (
    <div className="max-w-[92%] rounded-2xl rounded-bl-sm bg-surface-2 px-3.5 py-2.5">
      {turn.text ? (
        <Answer text={turn.text} citations={turn.citations} streaming={turn.status === "streaming"} />
      ) : turn.status === "streaming" ? (
        <span className="flex gap-1 py-1" role="status" aria-label="Thinking">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="size-1.5 animate-bounce rounded-full bg-muted"
              style={{ animationDelay: `${i * 120}ms` }}
            />
          ))}
        </span>
      ) : null}
      {turn.status === "error" && <p className="mt-1 text-sm text-danger">{turn.error}</p>}
      {turn.messageId && turn.status === "complete" && (
        <div className="mt-1.5 flex gap-1 text-muted">
          <button
            type="button"
            aria-label="Helpful"
            aria-pressed={turn.feedback === "up"}
            onClick={() => onRate(turn.feedback === "up" ? null : "up")}
            className={cx("rounded p-1 hover:text-fg", turn.feedback === "up" && "text-ok")}
          >
            <ThumbsUp className="size-3.5" aria-hidden />
          </button>
          <button
            type="button"
            aria-label="Not helpful"
            aria-pressed={turn.feedback === "down"}
            onClick={() => onRate(turn.feedback === "down" ? null : "down")}
            className={cx("rounded p-1 hover:text-fg", turn.feedback === "down" && "text-danger")}
          >
            <ThumbsDown className="size-3.5" aria-hidden />
          </button>
        </div>
      )}
    </div>
  );
}
