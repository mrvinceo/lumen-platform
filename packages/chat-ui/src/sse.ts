import type { ChatEvent } from "./types";

export class StreamError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfter?: number,
  ) {
    super(message);
  }
}

/** POSTs JSON and yields Server-Sent Events as parsed objects. Non-2xx responses throw StreamError. */
export async function* streamChatEvents(
  url: string,
  body: unknown,
  opts: { signal?: AbortSignal; headers?: Record<string, string>; credentials?: RequestCredentials } = {},
): AsyncGenerator<ChatEvent> {
  const res = await fetch(url, {
    method: "POST",
    credentials: opts.credentials ?? "same-origin",
    headers: { "content-type": "application/json", ...opts.headers },
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  if (!res.ok || !res.body) {
    const data = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
    const retry = Number(res.headers.get("retry-after") ?? "");
    throw new StreamError(
      res.status,
      data.error?.code ?? "error",
      data.error?.message ?? `Request failed (${res.status})`,
      Number.isFinite(retry) && retry > 0 ? retry : undefined,
    );
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let sep = buffer.indexOf("\n\n");
    while (sep !== -1) {
      const block = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const data = block
        .split("\n")
        .filter((l) => l.startsWith("data: "))
        .map((l) => l.slice(6))
        .join("\n");
      if (data) yield JSON.parse(data) as ChatEvent;
      sep = buffer.indexOf("\n\n");
    }
  }
}
