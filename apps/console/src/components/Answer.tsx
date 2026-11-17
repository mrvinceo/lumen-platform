import { FileText } from "lucide-react";
import { type CSSProperties, type ReactNode, useId, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Citation } from "../lib/api";
import { cx } from "./ui";

/** Turns [1], [1, 3] and [2-4] markers into links the renderer swaps for citation chips. */
export function linkCitations(text: string, available: Set<number>): string {
  return text.replace(/\[(\d{1,3}(?:\s*(?:,|-|–)\s*\d{1,3})*)\](?!\()/g, (whole, inner: string) => {
    const nums: number[] = [];
    for (const part of inner.split(",")) {
      const [a, b] = part.split(/-|–/).map((x) => Number.parseInt(x.trim(), 10));
      if (a === undefined || Number.isNaN(a)) continue;
      const end = b === undefined || Number.isNaN(b) ? a : b;
      for (let n = a; n <= end && n - a <= 20; n++) nums.push(n);
    }
    const valid = nums.filter((n) => available.has(n));
    return valid.length ? valid.map((n) => `[${n}](#cite-${n})`).join("") : whole;
  });
}

const POPOVER_WIDTH = 288;

function CitationChip({ citation }: { citation: Citation }) {
  const [pos, setPos] = useState<CSSProperties | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const id = useId();
  const open = pos !== null;
  // Fixed positioning so the popover is never clipped by the scrolling chat panel.
  const show = () => {
    const r = button.current?.getBoundingClientRect();
    if (!r) return;
    const left = Math.min(
      Math.max(8, r.left + r.width / 2 - POPOVER_WIDTH / 2),
      window.innerWidth - POPOVER_WIDTH - 8,
    );
    const above = r.top > 220;
    setPos(above ? { left, bottom: window.innerHeight - r.top + 8 } : { left, top: r.bottom + 8 });
  };
  const hide = () => setPos(null);
  return (
    <span className="inline-block align-baseline">
      <button
        ref={button}
        type="button"
        aria-describedby={open ? id : undefined}
        aria-label={`Source ${citation.n}: ${citation.title}`}
        onClick={() => (open ? hide() : show())}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        className="ml-0.5 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-accent-soft px-1.5 text-[11px] font-semibold text-accent hover:bg-accent hover:text-accent-fg"
      >
        {citation.n}
      </button>
      {open && (
        <span
          id={id}
          role="tooltip"
          style={{ ...pos, width: POPOVER_WIDTH, maxWidth: "calc(100vw - 16px)" }}
          className="fixed z-50 block rounded-xl border border-border bg-surface p-3 text-left text-xs shadow-xl"
        >
          <span className="flex items-center gap-1.5 font-medium text-fg">
            <FileText className="size-3.5 shrink-0" aria-hidden /> {citation.title}
          </span>
          {(citation.headings?.length || citation.page) && (
            <span className="mt-0.5 block text-muted">
              {citation.headings?.join(" › ")}
              {citation.page ? `${citation.headings?.length ? " · " : ""}page ${citation.page}` : ""}
            </span>
          )}
          <span className="mt-2 line-clamp-6 block whitespace-pre-line text-fg">
            {stripHeading(citation.snippet, citation.headings)}
          </span>
        </span>
      )}
    </span>
  );
}

function stripHeading(text: string, headings?: string[]) {
  const prefix = `${(headings ?? []).join(" › ")}\n\n`;
  return headings?.length && text.startsWith(prefix) ? text.slice(prefix.length) : text;
}

/** A bot answer rendered as safe Markdown (no raw HTML) with interactive citation chips and a sources footer. */
export function Answer({
  text,
  citations,
  streaming,
}: {
  text: string;
  citations: Citation[];
  streaming?: boolean;
}) {
  const byN = new Map(citations.map((c) => [c.n, c]));
  const md = linkCitations(text, new Set(byN.keys()));
  return (
    <div>
      <div className="answer text-sm leading-relaxed [&_li]:my-0.5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-2 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0 [&_table]:my-2 [&_td]:border [&_td]:border-border [&_td]:px-2 [&_th]:border [&_th]:border-border [&_th]:px-2 [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_code]:rounded [&_code]:bg-surface-2 [&_code]:px-1 [&_a]:text-accent [&_a]:underline">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            a: ({ href, children }) => {
              const m = /^#cite-(\d+)$/.exec(href ?? "");
              const c = m ? byN.get(Number(m[1])) : undefined;
              if (c) return <CitationChip citation={c} />;
              return (
                <a href={href} target="_blank" rel="noreferrer noopener">
                  {children as ReactNode}
                </a>
              );
            },
          }}
        >
          {md}
        </ReactMarkdown>
        {streaming && (
          <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-accent align-middle" aria-hidden />
        )}
      </div>
      {!streaming && citations.length > 0 && (
        <div className="mt-3 border-t border-border pt-2">
          <p className="mb-1 text-xs font-medium text-muted">Sources</p>
          <ol className="flex flex-col gap-1">
            {[...citations]
              .sort((a, b) => a.n - b.n)
              .map((c) => (
                <li key={c.n} className="flex items-start gap-2 text-xs">
                  <span
                    className={cx(
                      "inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-accent-soft px-1 text-[10px] font-semibold text-accent",
                    )}
                  >
                    {c.n}
                  </span>
                  <span className="min-w-0">
                    <span className="font-medium">{c.title}</span>
                    {c.headings?.length ? (
                      <span className="text-muted"> › {c.headings.join(" › ")}</span>
                    ) : null}
                    {c.page ? <span className="text-muted"> · page {c.page}</span> : null}
                  </span>
                </li>
              ))}
          </ol>
        </div>
      )}
    </div>
  );
}
