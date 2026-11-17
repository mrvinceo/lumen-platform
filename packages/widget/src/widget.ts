/**
 * Lumen chat widget loader.
 *
 *   <script src="https://<lumen-host>/widget.js" data-bot="pk_live_…" async></script>
 *
 * Adds a chat bubble in a Shadow DOM (so the host page's CSS can't affect it) and opens the chat in an iframe served
 * by Lumen. Lumen only lets that iframe render on the bot's allowed domains (CSP frame-ancestors).
 */
interface PublicConfig {
  branding: { title: string; primaryColor: string; position: "bottom-right" | "bottom-left" };
  /** false when the page isn't on the bot's allowed websites. */
  embeddable?: boolean;
}
type Listener = (detail?: unknown) => void;

(() => {
  const w = window as unknown as { Lumen?: unknown; __lumenLoaded?: boolean };
  if (w.__lumenLoaded) return;
  w.__lumenLoaded = true;

  const script =
    (document.currentScript as HTMLScriptElement | null) ??
    (document.querySelector("script[data-bot][src*='widget.js']") as HTMLScriptElement | null);
  const publicKey = script?.dataset.bot;
  if (!script || !publicKey) {
    console.warn('[Lumen] Add data-bot="pk_…" to the widget <script> tag.');
    return;
  }
  const origin = new URL(script.src, location.href).origin;
  const listeners: Record<string, Listener[]> = {};
  const emit = (name: string, detail?: unknown) => {
    for (const fn of listeners[name] ?? []) {
      try {
        fn(detail);
      } catch (err) {
        console.error("[Lumen] listener failed", err);
      }
    }
  };

  let open = false;
  let iframe: HTMLIFrameElement | undefined;
  let panel: HTMLDivElement;
  let button: HTMLButtonElement;
  let badge: HTMLSpanElement;

  const chatIcon =
    '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
  const closeIcon =
    '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';

  function textOn(hex: string): string {
    const n = Number.parseInt(hex.slice(1), 16);
    const lum = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
    return lum > 0.6 ? "#111827" : "#ffffff";
  }

  function mount(config: PublicConfig) {
    const color = /^#[0-9a-f]{6}$/i.test(config.branding.primaryColor)
      ? config.branding.primaryColor
      : "#4f46e5";
    const side = (script?.dataset.position ?? config.branding.position) === "bottom-left" ? "left" : "right";
    const host = document.createElement("div");
    host.id = "lumen-chat-widget";
    host.style.cssText = `position:fixed;z-index:2147483000;bottom:0;${side}:0;`;
    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `
      <style>
        :host { all: initial; }
        .btn { position: fixed; bottom: 20px; ${side}: 20px; width: 56px; height: 56px; border-radius: 50%; border: 0;
          background: ${color}; color: ${textOn(color)}; cursor: pointer; display: flex; align-items: center; justify-content: center;
          box-shadow: 0 6px 24px rgba(0,0,0,.22); transition: transform .15s ease; }
        .btn:hover { transform: scale(1.05); }
        .btn:focus-visible { outline: 3px solid ${color}; outline-offset: 3px; }
        .badge { position: absolute; top: 2px; right: 2px; width: 12px; height: 12px; border-radius: 50%; background: #ef4444;
          border: 2px solid #fff; display: none; }
        .panel { position: fixed; bottom: 90px; ${side}: 20px; width: 380px; height: min(640px, calc(100vh - 120px));
          border-radius: 16px; overflow: hidden; background: #fff; box-shadow: 0 12px 48px rgba(0,0,0,.25);
          display: none; }
        .panel.open { display: block; }
        iframe { width: 100%; height: 100%; border: 0; display: block; }
        @media (max-width: 520px) {
          .panel { inset: 0; width: 100%; height: 100%; border-radius: 0; bottom: 0; }
          .panel.open + .btn { display: none; }
        }
      </style>
      <div class="panel" role="dialog" aria-label="${config.branding.title.replace(/"/g, "&quot;")}"></div>
      <button class="btn" type="button" aria-label="Open chat" aria-expanded="false">${chatIcon}<span class="badge"></span></button>`;
    panel = root.querySelector(".panel") as HTMLDivElement;
    button = root.querySelector(".btn") as HTMLButtonElement;
    badge = root.querySelector(".badge") as HTMLSpanElement;
    button.addEventListener("click", () => (open ? close() : show()));
    document.addEventListener("keydown", (e) => {
      if (open && e.key === "Escape") close();
    });
    document.body.appendChild(host);
    if (script?.dataset.open === "true") show();
  }

  function tell(message: object) {
    iframe?.contentWindow?.postMessage(message, origin);
  }

  function show() {
    if (!panel) return;
    if (!iframe) {
      iframe = document.createElement("iframe");
      iframe.src = `${origin}/w/${encodeURIComponent(publicKey as string)}`;
      iframe.title = "Chat";
      iframe.allow = "clipboard-write";
      panel.appendChild(iframe);
    }
    open = true;
    panel.classList.add("open");
    button.innerHTML = `${closeIcon}<span class="badge"></span>`;
    badge = button.querySelector(".badge") as HTMLSpanElement;
    button.setAttribute("aria-label", "Close chat");
    button.setAttribute("aria-expanded", "true");
    tell({ type: "lumen:visibility", open: true });
    emit("open");
  }

  function close() {
    if (!panel) return;
    open = false;
    panel.classList.remove("open");
    button.innerHTML = `${chatIcon}<span class="badge"></span>`;
    badge = button.querySelector(".badge") as HTMLSpanElement;
    button.setAttribute("aria-label", "Open chat");
    button.setAttribute("aria-expanded", "false");
    tell({ type: "lumen:visibility", open: false });
    button.focus();
    emit("close");
  }

  // Only trust messages that come from our own iframe, on Lumen's origin.
  window.addEventListener("message", (e) => {
    if (e.origin !== origin || !iframe || e.source !== iframe.contentWindow) return;
    const type = (e.data as { type?: string })?.type;
    if (type === "lumen:close") close();
    else if (type === "lumen:ready") tell({ type: "lumen:visibility", open });
    else if (type === "lumen:unread" && !open && badge) badge.style.display = "block";
    if (type === "lumen:unread") emit("message");
  });

  w.Lumen = {
    open: show,
    close,
    toggle: () => (open ? close() : show()),
    on(event: "open" | "close" | "message", fn: Listener) {
      listeners[event] = [...(listeners[event] ?? []), fn];
    },
  };

  fetch(`${origin}/api/public/v1/bots/${encodeURIComponent(publicKey)}/config?channel=widget`)
    .then((r) => (r.ok ? (r.json() as Promise<PublicConfig>) : Promise.reject(new Error(`HTTP ${r.status}`))))
    .then((config) => {
      if (config.embeddable === false) {
        console.warn(
          `[Lumen] This site (${location.origin}) isn't in the assistant's allowed websites; add it in the Lumen console.`,
        );
        return;
      }
      if (document.body) mount(config);
      else document.addEventListener("DOMContentLoaded", () => mount(config));
    })
    .catch((err) => console.warn("[Lumen] Chat widget unavailable:", (err as Error).message));
})();
