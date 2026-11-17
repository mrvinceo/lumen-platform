import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, ExternalLink, KeyRound, Plus, RefreshCw, Trash2, XCircle } from "lucide-react";
import { type FormEvent, useMemo, useState } from "react";
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
  type Catalog,
  canManage,
  type ModelKind,
  type ProviderConfig,
  type TestResult,
} from "../lib/api";
import { useCurrentMe } from "../lib/session";

const KIND_LABEL: Record<ModelKind, string> = { llm: "Chat model", embedding: "Embedding model" };

export function ModelsPage() {
  const me = useCurrentMe();
  const manage = canManage(me.tenant?.role);
  const [adding, setAdding] = useState<ModelKind | null>(null);
  const [editing, setEditing] = useState<ProviderConfig | null>(null);
  const catalog = useQuery({
    queryKey: ["catalog"],
    queryFn: () => api<Catalog>("/api/v1/catalog"),
    staleTime: Number.POSITIVE_INFINITY,
  });
  const providers = useQuery({
    queryKey: ["providers"],
    queryFn: () => api<{ providers: ProviderConfig[] }>("/api/v1/providers"),
  });

  const list = providers.data?.providers ?? [];
  return (
    <>
      <PageHeader
        title="Models"
        description="Connect the AI providers your bots use. Keys are encrypted and never shown again after saving; each one is tested before it is saved."
      />
      {providers.isLoading && <Spinner />}
      {providers.error && <Alert tone="danger">{(providers.error as Error).message}</Alert>}
      {providers.data &&
        (["llm", "embedding"] as const).map((kind) => (
          <section key={kind} className="mb-8">
            <div className="mb-3 flex items-center justify-between gap-4">
              <div>
                <h2 className="font-semibold">{kind === "llm" ? "Chat models" : "Embedding models"}</h2>
                <p className="text-sm text-muted">
                  {kind === "llm"
                    ? "Write the answers your bots give."
                    : "Turn documents and questions into vectors for search."}
                </p>
              </div>
              {manage && (
                <Button variant="secondary" onClick={() => setAdding(kind)}>
                  <Plus className="size-4" aria-hidden /> Add
                </Button>
              )}
            </div>
            <ProviderList
              items={list.filter((p) => p.type === kind)}
              manage={manage}
              onEdit={setEditing}
              kind={kind}
            />
          </section>
        ))}
      <Modal
        open={adding !== null}
        onClose={() => setAdding(null)}
        title={`Add ${adding ? KIND_LABEL[adding].toLowerCase() : ""}`}
        wide
      >
        {adding && catalog.data && (
          <AddModelForm kind={adding} catalog={catalog.data} onDone={() => setAdding(null)} />
        )}
      </Modal>
      <Modal open={editing !== null} onClose={() => setEditing(null)} title="Edit model">
        {editing && <EditModelForm config={editing} onDone={() => setEditing(null)} />}
      </Modal>
    </>
  );
}

function ProviderList({
  items,
  manage,
  onEdit,
  kind,
}: {
  items: ProviderConfig[];
  manage: boolean;
  onEdit: (p: ProviderConfig) => void;
  kind: ModelKind;
}) {
  if (items.length === 0) {
    return (
      <Card className="border-dashed p-6 text-center text-sm text-muted">
        No {KIND_LABEL[kind].toLowerCase()}s yet.
        {manage ? " Add one to get started." : " Ask an admin to add one."}
      </Card>
    );
  }
  return (
    <Card>
      <ul className="divide-y divide-border">
        {items.map((p) => (
          <ProviderRow key={p.id} config={p} manage={manage} onEdit={() => onEdit(p)} />
        ))}
      </ul>
    </Card>
  );
}

function ProviderRow({
  config,
  manage,
  onEdit,
}: {
  config: ProviderConfig;
  manage: boolean;
  onEdit: () => void;
}) {
  const qc = useQueryClient();
  const me = useCurrentMe();
  const [result, setResult] = useState<TestResult>();
  const test = useMutation({
    mutationFn: () =>
      api<{ result: TestResult }>(`/api/v1/providers/${config.id}/test`, { method: "POST", body: {} }),
    onSuccess: (r) => setResult(r.result),
  });
  const remove = useMutation({
    mutationFn: () => api(`/api/v1/providers/${config.id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["providers"] }),
  });
  const canTest = me.tenant?.role !== "viewer";

  return (
    <li className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{config.label}</span>
          {config.dimension && <Badge>{config.dimension} dims</Badge>}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
          <span>{config.providerName}</span>
          <code className="text-xs">{config.model}</code>
          {config.keyHint && (
            <span className="inline-flex items-center gap-1">
              <KeyRound className="size-3.5" aria-hidden /> {config.keyHint}
            </span>
          )}
          {config.baseUrl && <span className="truncate">{config.baseUrl}</span>}
        </div>
        {result && (
          <p className={cx("mt-2 flex items-center gap-1.5 text-sm", result.ok ? "text-ok" : "text-danger")}>
            {result.ok ? (
              <CheckCircle2 className="size-4" aria-hidden />
            ) : (
              <XCircle className="size-4" aria-hidden />
            )}
            {result.message} {result.ok && <span className="text-muted">({result.latencyMs} ms)</span>}
          </p>
        )}
        {remove.error && <p className="mt-2 text-sm text-danger">{(remove.error as Error).message}</p>}
      </div>
      <div className="flex shrink-0 gap-2">
        {canTest && (
          <Button variant="secondary" loading={test.isPending} onClick={() => test.mutate()}>
            <RefreshCw className="size-4" aria-hidden /> Test
          </Button>
        )}
        {manage && (
          <>
            <Button variant="secondary" onClick={onEdit}>
              Edit
            </Button>
            <Button
              variant="danger"
              aria-label={`Delete ${config.label}`}
              loading={remove.isPending}
              onClick={() => {
                if (confirm(`Delete "${config.label}"? Its stored API key is deleted too.`)) remove.mutate();
              }}
            >
              <Trash2 className="size-4" aria-hidden />
            </Button>
          </>
        )}
      </div>
    </li>
  );
}

function AddModelForm({ kind, catalog, onDone }: { kind: ModelKind; catalog: Catalog; onDone: () => void }) {
  const qc = useQueryClient();
  const providers = catalog.providers.filter((p) => p.kinds.includes(kind));
  const [providerId, setProviderId] = useState(providers[0]?.id ?? "");
  const provider = providers.find((p) => p.id === providerId);
  const suggestions = useMemo(
    () => (kind === "llm" ? (provider?.llmModels ?? []) : (provider?.embeddingModels ?? [])),
    [kind, provider],
  );
  const firstModel = suggestions.find((m) => m.recommended) ?? suggestions[0];

  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState(firstModel?.id ?? "");
  const [label, setLabel] = useState("");
  const [dimension, setDimension] = useState<number>(
    kind === "embedding"
      ? ((firstModel as { defaultDimension?: number } | undefined)?.defaultDimension ??
          catalog.dimensions[0] ??
          768)
      : 0,
  );
  const [liveModels, setLiveModels] = useState<string[]>();
  const [result, setResult] = useState<TestResult>();
  const [error, setError] = useState<string>();

  const embeddingInfo =
    kind === "embedding" ? provider?.embeddingModels.find((m) => m.id === model) : undefined;
  const dimensionChoices = embeddingInfo?.dimensions ?? catalog.dimensions;

  function chooseProvider(id: string) {
    setProviderId(id);
    const p = providers.find((x) => x.id === id);
    const list = kind === "llm" ? (p?.llmModels ?? []) : (p?.embeddingModels ?? []);
    const first = list.find((m) => m.recommended) ?? list[0];
    setModel(first?.id ?? "");
    if (kind === "embedding")
      setDimension((first as { defaultDimension?: number } | undefined)?.defaultDimension ?? 768);
    setLiveModels(undefined);
    setResult(undefined);
    setError(undefined);
  }

  function chooseModel(id: string) {
    setModel(id);
    setResult(undefined);
    const info = provider?.embeddingModels.find((m) => m.id === id);
    if (info) setDimension(info.defaultDimension);
  }

  const draft = () => ({
    type: kind,
    provider: providerId,
    model: model.trim(),
    apiKey: apiKey.trim() || undefined,
    baseUrl: baseUrl.trim() || undefined,
    dimension: kind === "embedding" ? dimension : undefined,
  });

  const load = useMutation({
    mutationFn: () =>
      api<{ models: string[] }>("/api/v1/providers/models", {
        body: {
          provider: providerId,
          apiKey: apiKey.trim() || undefined,
          baseUrl: baseUrl.trim() || undefined,
        },
      }),
    onSuccess: (r) => setLiveModels(r.models),
    onError: (e) => setError((e as Error).message),
  });
  const test = useMutation({
    mutationFn: () => api<{ result: TestResult }>("/api/v1/providers/test", { body: draft() }),
    onSuccess: (r) => setResult(r.result),
    onError: (e) => setError((e as Error).message),
  });
  const save = useMutation({
    mutationFn: () => api("/api/v1/providers", { body: { ...draft(), label: label.trim() || undefined } }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["providers"] });
      onDone();
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === "connection_failed") setResult(e.details as TestResult);
      else setError((e as Error).message);
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    setError(undefined);
    save.mutate();
  }

  const modelOptions = liveModels ?? suggestions.map((m) => m.id);

  return (
    <form onSubmit={submit} className="flex flex-col gap-5">
      <fieldset>
        <legend className="mb-2 text-sm font-medium">Provider</legend>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {providers.map((p) => (
            <label
              key={p.id}
              className={cx(
                "flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2.5 text-sm transition",
                p.id === providerId ? "border-accent bg-accent-soft" : "border-border hover:bg-surface-2",
              )}
            >
              <input
                type="radio"
                name="provider"
                className="accent-[var(--accent)]"
                checked={p.id === providerId}
                onChange={() => chooseProvider(p.id)}
              />
              {p.name}
            </label>
          ))}
        </div>
      </fieldset>

      {provider?.baseUrl !== "none" && (
        <Field
          label="Base URL"
          htmlFor="baseUrl"
          hint="The endpoint's OpenAI-compatible root, e.g. http://localhost:11434/v1 for Ollama."
        >
          <Input
            id="baseUrl"
            type="url"
            required={provider?.baseUrl === "required"}
            placeholder="https://…/v1"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
          />
        </Field>
      )}

      <Field
        label={provider?.keyRequired ? "API key" : "API key (optional)"}
        htmlFor="apiKey"
        hint={
          <>
            Encrypted at rest; only the last four characters are shown after saving.{" "}
            {provider?.keyUrl && (
              <a
                href={provider.keyUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-0.5 text-accent hover:underline"
              >
                Get a key <ExternalLink className="size-3" aria-hidden />
              </a>
            )}
          </>
        }
      >
        <Input
          id="apiKey"
          type="password"
          autoComplete="off"
          required={provider?.keyRequired}
          placeholder={provider?.keyPlaceholder}
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
        />
      </Field>

      <Field
        label="Model"
        htmlFor="model"
        hint={
          <button
            type="button"
            className="text-accent hover:underline disabled:opacity-50"
            disabled={load.isPending || (provider?.keyRequired && !apiKey)}
            onClick={() => load.mutate()}
          >
            {load.isPending
              ? "Loading models…"
              : liveModels
                ? `Loaded ${liveModels.length} models from the provider`
                : "Load the full model list from the provider"}
          </button>
        }
      >
        <Input
          id="model"
          list="model-options"
          required
          value={model}
          onChange={(e) => chooseModel(e.target.value)}
          placeholder="Model id"
        />
        <datalist id="model-options">
          {modelOptions.map((id) => (
            <option key={id} value={id} />
          ))}
        </datalist>
        {!liveModels && suggestions.length > 0 && (
          <div className="flex flex-wrap gap-1.5 pt-1">
            {suggestions.map((m) => (
              <button
                type="button"
                key={m.id}
                onClick={() => chooseModel(m.id)}
                className={cx(
                  "rounded-full border px-2.5 py-1 text-xs transition",
                  model === m.id
                    ? "border-accent bg-accent-soft text-accent"
                    : "border-border text-muted hover:text-fg",
                )}
              >
                {m.label}
                {m.recommended && " ★"}
              </button>
            ))}
          </div>
        )}
      </Field>

      {kind === "embedding" && (
        <Field
          label="Vector size"
          htmlFor="dimension"
          hint="Fixed for every knowledge base that uses this model. Larger can be slightly more accurate but costs more storage."
        >
          <Select id="dimension" value={dimension} onChange={(e) => setDimension(Number(e.target.value))}>
            {dimensionChoices.map((d) => (
              <option key={d} value={d}>
                {d} dimensions
              </option>
            ))}
          </Select>
        </Field>
      )}

      <Field
        label="Name (optional)"
        htmlFor="label"
        hint="Shown when choosing a model for a bot or knowledge base."
      >
        <Input
          id="label"
          maxLength={100}
          placeholder={`${provider?.name ?? ""} · ${model}`}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
      </Field>

      {result && <Alert tone={result.ok ? "ok" : "danger"}>{result.message}</Alert>}
      {error && <Alert tone="danger">{error}</Alert>}

      <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-4">
        <Button
          variant="secondary"
          loading={test.isPending}
          disabled={!model}
          onClick={() => {
            setError(undefined);
            test.mutate();
          }}
        >
          Test connection
        </Button>
        <Button type="submit" loading={save.isPending} disabled={!model}>
          Test and save
        </Button>
      </div>
    </form>
  );
}

function EditModelForm({ config, onDone }: { config: ProviderConfig; onDone: () => void }) {
  const qc = useQueryClient();
  const [label, setLabel] = useState(config.label);
  const [model, setModel] = useState(config.model);
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string>();
  const save = useMutation({
    mutationFn: () =>
      api(`/api/v1/providers/${config.id}`, {
        method: "PATCH",
        body: {
          label: label.trim(),
          model: model.trim(),
          ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        },
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["providers"] });
      onDone();
    },
    onError: (e) => setError((e as Error).message),
  });
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        setError(undefined);
        save.mutate();
      }}
    >
      <Field label="Name" htmlFor="edit-label">
        <Input
          id="edit-label"
          required
          maxLength={100}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
      </Field>
      <Field
        label="Model"
        htmlFor="edit-model"
        hint={
          config.type === "embedding"
            ? "Changing an embedding model later will require re-indexing its knowledge bases."
            : undefined
        }
      >
        <Input id="edit-model" required value={model} onChange={(e) => setModel(e.target.value)} />
      </Field>
      <Field
        label="Replace API key"
        htmlFor="edit-key"
        hint={`Current key: ${config.keyHint ?? "none"}. Leave blank to keep it.`}
      >
        <Input
          id="edit-key"
          type="password"
          autoComplete="off"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
        />
      </Field>
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="flex justify-end gap-2 border-t border-border pt-4">
        <Button variant="secondary" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" loading={save.isPending}>
          Test and save
        </Button>
      </div>
    </form>
  );
}
