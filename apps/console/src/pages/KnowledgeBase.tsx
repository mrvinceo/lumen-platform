import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, FileText, RotateCw, Search, Trash2, UploadCloud } from "lucide-react";
import { type DragEvent, type FormEvent, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { Alert, Badge, Button, Card, cx, Input, PageHeader, Spinner } from "../components/ui";
import {
  type Audience,
  api,
  canEdit,
  canManage,
  type KbDocument,
  type KnowledgeBase,
  type SearchHit,
  uploadFiles,
} from "../lib/api";
import { useCurrentMe } from "../lib/session";

const STATUS: Record<KbDocument["status"], { label: string; tone: "neutral" | "ok" | "danger" | "accent" }> =
  {
    pending: { label: "Queued", tone: "neutral" },
    indexing: { label: "Indexing", tone: "accent" },
    indexed: { label: "Indexed", tone: "ok" },
    excluded: { label: "Excluded", tone: "neutral" },
    error: { label: "Failed", tone: "danger" },
  };

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Chunk text starts with its heading trail (useful for embeddings); the card already shows it. */
function withoutHeadingPrefix(text: string, headings: string[]): string {
  const prefix = `${headings.join(" › ")}\n\n`;
  return headings.length && text.startsWith(prefix) ? text.slice(prefix.length) : text;
}

function formatSize(bytes: number | null) {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function KnowledgeBasePage() {
  const { id = "" } = useParams();
  const me = useCurrentMe();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const kb = useQuery({
    queryKey: ["knowledge-base", id],
    queryFn: () => api<{ knowledgeBase: KnowledgeBase }>(`/api/v1/knowledge-bases/${id}`),
  });
  const docs = useQuery({
    queryKey: ["documents", id],
    queryFn: () => api<{ documents: KbDocument[] }>(`/api/v1/knowledge-bases/${id}/documents`),
    // Poll while anything is still being processed.
    refetchInterval: (q) =>
      q.state.data?.documents.some((d) => d.status === "pending" || d.status === "indexing") ? 2000 : false,
  });
  const remove = useMutation({
    mutationFn: () => api(`/api/v1/knowledge-bases/${id}`, { method: "DELETE" }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["knowledge-bases"] });
      navigate("/knowledge");
    },
  });

  if (kb.isLoading) return <Spinner />;
  if (kb.error || !kb.data) return <Alert tone="danger">{(kb.error as Error)?.message ?? "Not found"}</Alert>;
  const k = kb.data.knowledgeBase;
  const documents = docs.data?.documents ?? [];
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["documents", id] });
    void qc.invalidateQueries({ queryKey: ["knowledge-base", id] });
  };

  return (
    <>
      <Link to="/knowledge" className="mb-4 inline-flex items-center gap-1 text-sm text-muted hover:text-fg">
        <ArrowLeft className="size-4" aria-hidden /> Knowledge
      </Link>
      <PageHeader
        title={k.name}
        description={k.description ?? undefined}
        actions={
          canManage(me.tenant?.role) && (
            <Button
              variant="danger"
              loading={remove.isPending}
              onClick={() => {
                if (confirm(`Delete "${k.name}" and all of its documents? This can't be undone.`))
                  remove.mutate();
              }}
            >
              <Trash2 className="size-4" aria-hidden /> Delete
            </Button>
          )
        }
      />
      <div className="mb-6 flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted">
        <span>
          Embedding: <span className="text-fg">{k.embeddingLabel}</span> ({k.dimension} dims)
        </span>
        <span>
          Store: <span className="text-fg">{k.vectorStoreLabel}</span>
        </span>
        {docs.data && (
          <span>
            {documents.filter((d) => d.status === "indexed").length}/{documents.length} documents indexed ·{" "}
            {plural(
              documents.reduce((n, d) => n + d.chunkCount, 0),
              "chunk",
            )}
          </span>
        )}
      </div>

      {canEdit(me.tenant?.role) && <UploadArea kbId={id} onUploaded={refresh} />}

      <section className="mt-8">
        <h2 className="mb-3 font-semibold">Documents</h2>
        {docs.isLoading && <Spinner />}
        {docs.data && documents.length === 0 && (
          <Card className="border-dashed p-6 text-center text-sm text-muted">No documents yet.</Card>
        )}
        {documents.length > 0 && (
          <Card>
            <ul className="divide-y divide-border">
              {documents.map((d) => (
                <DocumentRow
                  key={d.id}
                  kbId={id}
                  doc={d}
                  canEdit={canEdit(me.tenant?.role)}
                  onChanged={refresh}
                />
              ))}
            </ul>
          </Card>
        )}
      </section>

      <SearchPreview kbId={id} disabled={k.indexedCount === 0} />
    </>
  );
}

function UploadArea({ kbId, onUploaded }: { kbId: string; onUploaded: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [audience, setAudience] = useState<Audience>("public");
  const [dragging, setDragging] = useState(false);
  const [rejected, setRejected] = useState<{ filename: string; reason: string }[]>([]);
  const upload = useMutation({
    mutationFn: (files: File[]) => uploadFiles(kbId, files, audience),
    onSuccess: (r) => {
      setRejected(r.rejected);
      onUploaded();
    },
  });

  const send = (list: FileList | null) => {
    const files = [...(list ?? [])];
    if (files.length) {
      setRejected([]);
      upload.mutate(files);
    }
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    send(e.dataTransfer.files);
  };

  return (
    <div>
      <button
        type="button"
        aria-label="Upload documents"
        onClick={() => input.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={cx(
          "flex w-full cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-6 py-8 text-center transition",
          dragging ? "border-accent bg-accent-soft" : "border-border bg-surface hover:bg-surface-2",
        )}
      >
        <UploadCloud className="size-8 text-muted" aria-hidden />
        <span className="font-medium">
          {upload.isPending ? "Uploading…" : "Drop files here or click to choose"}
        </span>
        <span className="text-sm text-muted">
          PDF, Word, PowerPoint, Excel, CSV, Markdown, HTML or text · up to 50 MB each
        </span>
      </button>
      <input
        ref={input}
        type="file"
        multiple
        className="hidden"
        data-testid="file-input"
        accept=".pdf,.docx,.pptx,.xlsx,.odt,.odp,.ods,.csv,.md,.markdown,.html,.htm,.txt"
        onChange={(e) => {
          send(e.target.files);
          e.target.value = "";
        }}
      />
      <fieldset className="mt-3 flex flex-wrap items-center gap-4 text-sm">
        <legend className="sr-only">Who can see these documents</legend>
        <span className="text-muted">Visible to:</span>
        {(["public", "staff"] as const).map((a) => (
          <label key={a} className="flex items-center gap-1.5">
            <input
              type="radio"
              name="audience"
              className="accent-[var(--accent)]"
              checked={audience === a}
              onChange={() => setAudience(a)}
            />
            {a === "public" ? "Everyone (customers and staff)" : "Staff only"}
          </label>
        ))}
      </fieldset>
      {upload.error && (
        <div className="mt-3">
          <Alert tone="danger">{(upload.error as Error).message}</Alert>
        </div>
      )}
      {rejected.length > 0 && (
        <div className="mt-3">
          <Alert tone="danger">
            {rejected.map((r) => (
              <div key={r.filename}>
                <span className="font-medium">{r.filename}</span>: {r.reason}
              </div>
            ))}
          </Alert>
        </div>
      )}
    </div>
  );
}

function DocumentRow({
  kbId,
  doc,
  canEdit,
  onChanged,
}: {
  kbId: string;
  doc: KbDocument;
  canEdit: boolean;
  onChanged: () => void;
}) {
  const reindex = useMutation({
    mutationFn: () =>
      api(`/api/v1/knowledge-bases/${kbId}/documents/${doc.id}/reindex`, { method: "POST", body: {} }),
    onSuccess: onChanged,
  });
  const remove = useMutation({
    mutationFn: () => api(`/api/v1/knowledge-bases/${kbId}/documents/${doc.id}`, { method: "DELETE" }),
    onSuccess: onChanged,
  });
  const s = STATUS[doc.status];
  return (
    <li className="flex flex-col gap-2 px-5 py-3 sm:flex-row sm:items-center">
      <FileText className="hidden size-5 shrink-0 text-muted sm:block" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate font-medium">{doc.title}</span>
          <Badge tone={s.tone}>{s.label}</Badge>
          {doc.audience === "staff" && <Badge>Staff only</Badge>}
        </div>
        <div className="text-xs text-muted">
          {[formatSize(doc.sizeBytes), doc.status === "indexed" ? plural(doc.chunkCount, "chunk") : ""]
            .filter(Boolean)
            .join(" · ")}
        </div>
        {doc.error && <p className="mt-1 text-sm text-danger">{doc.error}</p>}
      </div>
      {canEdit && (
        <div className="flex shrink-0 gap-2">
          {(doc.status === "error" || doc.status === "indexed") && (
            <Button
              variant="secondary"
              aria-label={`Re-index ${doc.title}`}
              loading={reindex.isPending}
              onClick={() => reindex.mutate()}
            >
              <RotateCw className="size-4" aria-hidden />
            </Button>
          )}
          <Button
            variant="danger"
            aria-label={`Delete ${doc.title}`}
            loading={remove.isPending}
            onClick={() => {
              if (confirm(`Delete "${doc.title}"?`)) remove.mutate();
            }}
          >
            <Trash2 className="size-4" aria-hidden />
          </Button>
        </div>
      )}
    </li>
  );
}

function SearchPreview({ kbId, disabled }: { kbId: string; disabled: boolean }) {
  const [query, setQuery] = useState("");
  const [staff, setStaff] = useState(true);
  const search = useMutation({
    mutationFn: () =>
      api<{ hits: SearchHit[]; latencyMs: number }>(`/api/v1/knowledge-bases/${kbId}/search`, {
        body: { query, audiences: staff ? ["public", "staff"] : ["public"] },
      }),
  });
  return (
    <section className="mt-8">
      <h2 className="font-semibold">Search preview</h2>
      <p className="mb-3 text-sm text-muted">
        Check what a bot would retrieve for a question. This doesn't call your chat model.
      </p>
      <form
        className="flex flex-col gap-2 sm:flex-row"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          if (query.trim()) search.mutate();
        }}
      >
        <Input
          aria-label="Search query"
          placeholder="e.g. How do I return an item?"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          disabled={disabled}
        />
        <Button type="submit" loading={search.isPending} disabled={disabled || !query.trim()}>
          <Search className="size-4" aria-hidden /> Search
        </Button>
      </form>
      <label className="mt-2 flex items-center gap-2 text-sm text-muted">
        <input
          type="checkbox"
          className="accent-[var(--accent)]"
          checked={staff}
          onChange={(e) => setStaff(e.target.checked)}
        />{" "}
        Include staff-only documents
      </label>
      {disabled && <p className="mt-2 text-sm text-muted">Upload and index a document to try searching.</p>}
      {search.error && (
        <div className="mt-3">
          <Alert tone="danger">{(search.error as Error).message}</Alert>
        </div>
      )}
      {search.data && (
        <div className="mt-4 flex flex-col gap-3">
          <p className="text-xs text-muted">
            {plural(search.data.hits.length, "match").replace("matchs", "matches")} in {search.data.latencyMs}{" "}
            ms
          </p>
          {search.data.hits.length === 0 && <Card className="p-4 text-sm text-muted">Nothing matched.</Card>}
          {search.data.hits.map((h, i) => (
            <Card key={h.chunkId} className="p-4">
              <div className="mb-2 flex flex-wrap items-center gap-2 text-sm">
                <span className="font-mono text-xs text-muted">#{i + 1}</span>
                <span className="font-medium">{h.documentTitle}</span>
                {h.headings.length > 0 && <span className="text-muted">› {h.headings.join(" › ")}</span>}
                {h.page && <span className="text-muted">· page {h.page}</span>}
                {h.audience === "staff" && <Badge>Staff only</Badge>}
                <Badge tone="accent">{Math.round(h.score * 100)}% match</Badge>
              </div>
              <p className="line-clamp-6 whitespace-pre-line text-sm">
                {withoutHeadingPrefix(h.text, h.headings)}
              </p>
            </Card>
          ))}
        </div>
      )}
    </section>
  );
}
