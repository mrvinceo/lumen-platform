/** Minimal fetch double: routes on method + URL substring and records requests for assertions. */
export interface Recorded {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

type Handler = (req: Recorded) => Response | Promise<Response>;

export function fakeFetch(routes: [match: string, handler: Handler][]) {
  const calls: Recorded[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const req = input instanceof Request ? input : undefined;
    const url = req ? req.url : String(input);
    const method = (init?.method ?? req?.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init?.headers ?? req?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    const rawBody = init?.body ?? (req ? await req.text() : undefined);
    let body: unknown = rawBody;
    if (typeof rawBody === "string") {
      try {
        body = JSON.parse(rawBody);
      } catch {
        body = rawBody;
      }
    }
    const rec = { method, url, headers, body };
    calls.push(rec);
    const route = routes.find(([m]) => `${method} ${url}`.includes(m));
    if (!route) return json({ error: { message: `no fake route for ${method} ${url}` } }, 404);
    return route[1](rec);
  }) as typeof fetch;
  return { fetch: fn, calls };
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export function sse(events: { event?: string; data: unknown }[]): Response {
  const text = events
    .map(
      (e) =>
        `${e.event ? `event: ${e.event}\n` : ""}data: ${typeof e.data === "string" ? e.data : JSON.stringify(e.data)}\n\n`,
    )
    .join("");
  return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
}
