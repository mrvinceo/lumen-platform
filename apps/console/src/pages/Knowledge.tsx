import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpen, Database, Plus } from "lucide-react";
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
import {
  ApiError,
  api,
  canManage,
  type KnowledgeBase,
  type ProviderConfig,
  type VectorStoreInfo,
} from "../lib/api";
import { useCurrentMe } from "../lib/session";

export function KnowledgePage() {
  const me = useCurrentMe();
  const manage = canManage(me.tenant?.role);
  const [creating, setCreating] = useState(false);
  const kbs = useQuery({
    queryKey: ["knowledge-bases"],
    queryFn: () => api<{ knowledgeBases: KnowledgeBase[] }>("/api/v1/knowledge-bases"),
    refetchInterval: (q) => (q.state.data?.knowledgeBases.some((k) => k.pendingCount > 0) ? 2000 : false),
  });
  const list = kbs.data?.knowledgeBases ?? [];

  return (
    <>
      <PageHeader
        title="Knowledge"
        description="Knowledge bases hold the documents your bots answer from. Each one uses one embedding model and one vector store."
        actions={
          manage && (
            <Button onClick={() => setCreating(true)}>
              <Plus className="size-4" aria-hidden /> New knowledge base
            </Button>
          )
        }
      />
      {kbs.isLoading && <Spinner />}
      {kbs.error && <Alert tone="danger">{(kbs.error as Error).message}</Alert>}
      {kbs.data && list.length === 0 && (
        <Card className="border-dashed p-8 text-center">
          <BookOpen className="mx-auto size-8 text-muted" aria-hidden />
          <p className="mt-3 font-medium">No knowledge bases yet</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted">
            {manage
              ? "Create one, then upload documents such as policies, FAQs, handbooks or product guides."
              : "Ask an admin to create one."}
          </p>
        </Card>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        {list.map((kb) => (
          <Link key={kb.id} to={`/knowledge/${kb.id}`} className="block">
            <Card className="h-full p-5 transition hover:border-accent">
              <div className="flex items-start justify-between gap-3">
                <h2 className="font-semibold">{kb.name}</h2>
                {kb.pendingCount > 0 ? (
                  <Badge tone="accent">Indexing {kb.pendingCount}</Badge>
                ) : kb.errorCount > 0 ? (
                  <Badge tone="danger">{kb.errorCount} failed</Badge>
                ) : kb.documentCount > 0 ? (
                  <Badge tone="ok">Ready</Badge>
                ) : (
                  <Badge>Empty</Badge>
                )}
              </div>
              {kb.description && <p className="mt-1 line-clamp-2 text-sm text-muted">{kb.description}</p>}
              <dl className="mt-4 grid grid-cols-2 gap-2 text-sm">
                <div>
                  <dt className="text-xs text-muted">Documents</dt>
                  <dd>{kb.documentCount}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted">Chunks</dt>
                  <dd>{kb.chunkCount}</dd>
                </div>
                <div className="min-w-0">
                  <dt className="text-xs text-muted">Embedding</dt>
                  <dd className="truncate">{kb.embeddingLabel}</dd>
                </div>
                <div className="min-w-0">
                  <dt className="text-xs text-muted">Vector store</dt>
                  <dd className="truncate">{kb.vectorStoreLabel}</dd>
                </div>
              </dl>
            </Card>
          </Link>
        ))}
      </div>
      <Modal open={creating} onClose={() => setCreating(false)} title="New knowledge base" wide>
        <CreateKnowledgeBase onDone={() => setCreating(false)} />
      </Modal>
    </>
  );
}

function CreateKnowledgeBase({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const models = useQuery({
    queryKey: ["providers"],
    queryFn: () => api<{ providers: ProviderConfig[] }>("/api/v1/providers"),
  });
  const stores = useQuery({
    queryKey: ["vector-stores"],
    queryFn: () => api<{ vectorStores: VectorStoreInfo[] }>("/api/v1/vector-stores"),
  });
  const embeddingModels = (models.data?.providers ?? []).filter((p) => p.type === "embedding");

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [embeddingConfigId, setEmbeddingConfigId] = useState<string>();
  const [vectorStoreId, setVectorStoreId] = useState<string>();
  const [addingStore, setAddingStore] = useState(false);
  const [error, setError] = useState<{ message: string; action?: string }>();

  const modelId = embeddingConfigId ?? embeddingModels[0]?.id;
  const storeId = vectorStoreId ?? stores.data?.vectorStores[0]?.id;

  const create = useMutation({
    mutationFn: () =>
      api<{ knowledgeBase: KnowledgeBase }>("/api/v1/knowledge-bases", {
        body: {
          name: name.trim(),
          description: description.trim() || undefined,
          embeddingConfigId: modelId,
          vectorStoreId: storeId,
        },
      }),
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: ["knowledge-bases"] });
      onDone();
      navigate(`/knowledge/${r.knowledgeBase.id}`);
    },
    onError: (e) => {
      const action =
        e instanceof ApiError ? (e.details as { action?: string } | undefined)?.action : undefined;
      setError({ message: (e as Error).message, action });
    },
  });

  if (models.isLoading || stores.isLoading) return <Spinner />;
  if (embeddingModels.length === 0) {
    return (
      <Alert tone="info">
        Add an embedding model on the{" "}
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
        create.mutate();
      }}
    >
      <Field label="Name" htmlFor="kb-name">
        <Input
          id="kb-name"
          required
          maxLength={100}
          placeholder="Customer help centre"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </Field>
      <Field label="Description (optional)" htmlFor="kb-desc">
        <Input
          id="kb-desc"
          maxLength={500}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </Field>
      <Field label="Embedding model" htmlFor="kb-model" hint="Fixed once the knowledge base is created.">
        <Select id="kb-model" value={modelId} onChange={(e) => setEmbeddingConfigId(e.target.value)}>
          {embeddingModels.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label} ({m.dimension} dims)
            </option>
          ))}
        </Select>
      </Field>
      <fieldset>
        <legend className="mb-2 text-sm font-medium">Vector store</legend>
        <div className="flex flex-col gap-2">
          {(stores.data?.vectorStores ?? []).map((s) => (
            <label
              key={s.id}
              className={cx(
                "flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 text-sm transition",
                s.id === storeId ? "border-accent bg-accent-soft" : "border-border hover:bg-surface-2",
              )}
            >
              <input
                type="radio"
                name="store"
                className="mt-0.5 accent-[var(--accent)]"
                checked={s.id === storeId}
                onChange={() => setVectorStoreId(s.id)}
              />
              <span className="min-w-0">
                <span className="flex items-center gap-2 font-medium">
                  <Database className="size-4 text-muted" aria-hidden /> {s.label}
                  {s.managed && <Badge tone="accent">Recommended</Badge>}
                </span>
                <span className="text-muted">
                  {s.managed
                    ? "Stored in Lumen's own database. Nothing to set up."
                    : `Your ${s.providerName} account.`}
                </span>
              </span>
            </label>
          ))}
        </div>
        <button
          type="button"
          className="mt-2 text-sm text-accent hover:underline"
          onClick={() => setAddingStore((v) => !v)}
        >
          {addingStore ? "Cancel" : "Use your own Pinecone or Firestore…"}
        </button>
        {addingStore && (
          <div className="mt-3 rounded-lg border border-border p-4">
            <AddVectorStore
              onAdded={(id) => {
                setVectorStoreId(id);
                setAddingStore(false);
              }}
            />
          </div>
        )}
      </fieldset>
      {error && (
        <Alert tone="danger">
          {error.message}
          {error.action && (
            <code className="mt-2 block break-all rounded bg-surface p-2 text-xs text-fg">
              {error.action}
            </code>
          )}
        </Alert>
      )}
      <div className="flex justify-end gap-2 border-t border-border pt-4">
        <Button variant="secondary" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" loading={create.isPending} disabled={!name.trim() || !modelId}>
          Create knowledge base
        </Button>
      </div>
    </form>
  );
}

function AddVectorStore({ onAdded }: { onAdded: (id: string) => void }) {
  const qc = useQueryClient();
  const [provider, setProvider] = useState<"pinecone" | "firestore">("pinecone");
  const [apiKey, setApiKey] = useState("");
  const [indexName, setIndexName] = useState("");
  const [serviceAccountJson, setServiceAccountJson] = useState("");
  const [error, setError] = useState<string>();
  const add = useMutation({
    mutationFn: () =>
      api<{ vectorStore: VectorStoreInfo }>("/api/v1/vector-stores", {
        body:
          provider === "pinecone"
            ? { provider, apiKey: apiKey.trim(), indexName: indexName.trim() }
            : { provider, serviceAccountJson },
      }),
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: ["vector-stores"] });
      onAdded(r.vectorStore.id);
    },
    onError: (e) => setError((e as Error).message),
  });

  async function readKeyFile(file: File | undefined) {
    if (file) setServiceAccountJson(await file.text());
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex gap-2">
        {(["pinecone", "firestore"] as const).map((p) => (
          <Button key={p} variant={provider === p ? "primary" : "secondary"} onClick={() => setProvider(p)}>
            {p === "pinecone" ? "Pinecone" : "Firestore"}
          </Button>
        ))}
      </div>
      {provider === "pinecone" ? (
        <>
          <Field label="Pinecone API key" htmlFor="pc-key">
            <Input
              id="pc-key"
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
          </Field>
          <Field
            label="Index name"
            htmlFor="pc-index"
            hint="A dense index with the cosine metric and the same dimension as your embedding model."
          >
            <Input
              id="pc-index"
              placeholder="lumen"
              value={indexName}
              onChange={(e) => setIndexName(e.target.value)}
            />
          </Field>
        </>
      ) : (
        <Field
          label="Service account key (JSON)"
          htmlFor="fs-key"
          hint="Create a key for a service account with the Cloud Datastore User role. Embeddings must be 2048 dimensions or fewer."
        >
          <Input
            id="fs-key"
            type="file"
            accept="application/json,.json"
            onChange={(e) => readKeyFile(e.target.files?.[0])}
          />
          {serviceAccountJson && <span className="text-xs text-ok">Key file loaded.</span>}
        </Field>
      )}
      {error && <Alert tone="danger">{error}</Alert>}
      <div>
        <Button
          loading={add.isPending}
          disabled={provider === "pinecone" ? !apiKey || !indexName : !serviceAccountJson}
          onClick={() => {
            setError(undefined);
            add.mutate();
          }}
        >
          Test and add
        </Button>
      </div>
    </div>
  );
}
