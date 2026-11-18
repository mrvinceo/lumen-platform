import { type ChatEvent, StreamError, streamChatEvents } from "@lumen/chat-ui";

export interface PublicConfig {
  name: string;
  ready: boolean;
  branding: {
    title: string;
    greeting: string;
    primaryColor: string;
    logoUrl?: string;
    suggestedQuestions: string[];
    position: "bottom-right" | "bottom-left";
    theme: "light" | "dark" | "auto";
  };
}

export interface StoredMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  citations: { n: number; title: string; headings?: string[]; page?: number }[];
  status: "complete" | "error" | "stopped";
  feedback: "up" | "down" | null;
}

export type Channel = "widget" | "hosted";

const store = {
  get(key: string): string | undefined {
    try {
      return localStorage.getItem(key) ?? undefined;
    } catch {
      return undefined;
    }
  },
  set(key: string, value: string | undefined) {
    try {
      if (value === undefined) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch {
      /* storage blocked: the chat still works, it just isn't remembered */
    }
  },
};

/** Talks to Lumen's public API for one bot. Holds the short-lived visitor token in memory and renews it. */
export class PublicClient {
  private token?: string;

  constructor(
    readonly publicKey: string,
    readonly channel: Channel,
  ) {}

  private get visitorKey() {
    return `lumen:visitor:${this.publicKey}`;
  }
  get conversationKey() {
    return `lumen:conversation:${this.channel}:${this.publicKey}`;
  }

  async config(): Promise<PublicConfig> {
    // Revalidate rather than reuse a cached copy, so saved branding shows up straight away (e.g. the console preview).
    const res = await fetch(
      `/api/public/v1/bots/${encodeURIComponent(this.publicKey)}/config?channel=${this.channel}`,
      {
        cache: "no-cache",
      },
    );
    if (!res.ok) throw new StreamError(res.status, "unavailable", "This assistant isn't available.");
    return res.json() as Promise<PublicConfig>;
  }

  private async session(): Promise<string> {
    const res = await fetch(`/api/public/v1/bots/${encodeURIComponent(this.publicKey)}/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channel: this.channel, visitorId: store.get(this.visitorKey) }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      token?: string;
      visitorId?: string;
      error?: { message?: string };
    };
    if (!res.ok || !data.token)
      throw new StreamError(res.status, "session", data.error?.message ?? "Couldn't start a chat.");
    store.set(this.visitorKey, data.visitorId);
    this.token = data.token;
    return data.token;
  }

  private async authed<T>(fn: (token: string) => Promise<T>): Promise<T> {
    try {
      return await fn(this.token ?? (await this.session()));
    } catch (err) {
      // Tokens are short-lived: renew once and retry.
      if (err instanceof StreamError && err.status === 401) return fn(await this.session());
      throw err;
    }
  }

  savedConversation(): string | undefined {
    return store.get(this.conversationKey);
  }
  saveConversation(id: string | undefined) {
    store.set(this.conversationKey, id);
  }

  history(conversationId: string): Promise<StoredMessage[]> {
    return this.authed(async (token) => {
      const res = await fetch(`/api/public/v1/conversations/${conversationId}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new StreamError(res.status, "history", "Conversation not found.");
      return ((await res.json()) as { messages: StoredMessage[] }).messages;
    });
  }

  chat(
    message: string,
    conversationId: string | undefined,
    signal: AbortSignal,
  ): Promise<AsyncGenerator<ChatEvent>> {
    // The first request (and any 401 renewal) happens before streaming starts.
    return this.authed(async (token) => {
      const gen = streamChatEvents(
        "/api/public/v1/chat",
        { message, conversationId },
        { signal, headers: { authorization: `Bearer ${token}` } },
      );
      const first = await gen.next();
      return (async function* () {
        if (!first.done) yield first.value;
        yield* gen;
      })();
    });
  }

  feedback(messageId: string, feedback: "up" | "down" | null) {
    return this.authed((token) =>
      fetch(`/api/public/v1/messages/${messageId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ feedback }),
      }),
    );
  }
}

/** Readable text colour and a soft tint for any brand colour. */
export function accentPalette(hex: string, dark: boolean) {
  const n = Number.parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const lum = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  const fg = lum > 0.45 ? "#111827" : "#ffffff";
  const soft = dark ? `rgba(${r}, ${g}, ${b}, 0.22)` : `rgba(${r}, ${g}, ${b}, 0.12)`;
  return { accent: hex, fg, soft };
}

/** Messages to the embedding page (loader). They carry no secrets. */
export function postToHost(message: { type: "lumen:ready" | "lumen:close" | "lumen:unread" }) {
  if (window.parent !== window) window.parent.postMessage(message, "*");
}
