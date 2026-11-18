import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, ExternalLink, RefreshCw } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Alert, Button, Card, Field, Input, Select } from "../components/ui";
import { api, type Bot, type BotBranding, canEdit } from "../lib/api";
import { useCurrentMe } from "../lib/session";

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="secondary"
      aria-label={label}
      onClick={async () => {
        await navigator.clipboard?.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? <Check className="size-4" aria-hidden /> : <Copy className="size-4" aria-hidden />}
      {copied ? "Copied" : "Copy"}
    </Button>
  );
}

export function BotEmbed({ bot }: { bot: Bot }) {
  const me = useCurrentMe();
  const qc = useQueryClient();
  const editable = canEdit(me.tenant?.role);
  const origin = window.location.origin;
  const snippet = `<script src="${origin}/widget.js" data-bot="${bot.publicKey}" async></script>`;
  const hostedUrl = `${origin}/b/${bot.publicKey}`;
  const testPageUrl = `${origin}/t/${bot.publicKey}`;

  const [domains, setDomains] = useState(bot.allowedOrigins.join("\n"));
  const [widgetEnabled, setWidgetEnabled] = useState(bot.widgetEnabled);
  const [hostedPageEnabled, setHostedPageEnabled] = useState(bot.hostedPageEnabled);
  const [branding, setBranding] = useState<BotBranding>({
    title: bot.branding.title ?? "",
    greeting: bot.branding.greeting ?? "",
    primaryColor: bot.branding.primaryColor ?? "#4f46e5",
    logoUrl: bot.branding.logoUrl ?? "",
    suggestedQuestions: bot.branding.suggestedQuestions ?? [],
    position: bot.branding.position ?? "bottom-right",
    theme: bot.branding.theme ?? "auto",
  });
  const [cap, setCap] = useState(bot.monthlyMessageCap?.toString() ?? "");
  const [error, setError] = useState<string>();
  const [previewKey, setPreviewKey] = useState(0);
  const questions = [...(branding.suggestedQuestions ?? []), "", "", "", ""].slice(0, 4);
  const set = (patch: Partial<BotBranding>) => setBranding((b) => ({ ...b, ...patch }));

  const save = useMutation({
    mutationFn: () =>
      api<{ bot: Bot }>(`/api/v1/bots/${bot.id}`, {
        method: "PATCH",
        body: {
          allowedOrigins: domains
            .split(/[\n,]/)
            .map((d) => d.trim())
            .filter(Boolean),
          widgetEnabled,
          hostedPageEnabled,
          monthlyMessageCap: cap.trim() ? Number(cap) : null,
          branding: {
            ...branding,
            suggestedQuestions: (branding.suggestedQuestions ?? []).map((q) => q.trim()).filter(Boolean),
          },
        },
      }),
    onSuccess: async (r) => {
      setDomains(r.bot.allowedOrigins.join("\n"));
      await qc.invalidateQueries({ queryKey: ["bot", bot.id] });
      setPreviewKey((k) => k + 1);
    },
    onError: (e) => setError((e as Error).message),
  });

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_400px]">
      <div className="flex flex-col gap-6">
        <Card className="p-5">
          <h2 className="font-semibold">Add it to your website</h2>
          <p className="mt-1 text-sm text-muted">
            Paste this just before <code>&lt;/body&gt;</code> on every page where the chat bubble should
            appear.
          </p>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-start">
            <pre className="min-w-0 flex-1 overflow-x-auto rounded-lg bg-surface-2 p-3 text-xs">
              <code>{snippet}</code>
            </pre>
            <CopyButton text={snippet} label="Copy embed code" />
          </div>
          {bot.widgetEnabled && (
            <p className="mt-3 text-sm text-muted">
              Try the bubble on a sample page, with no website needed:{" "}
              <a
                href={testPageUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 font-medium text-accent hover:underline"
              >
                Open test page <ExternalLink className="size-3.5" aria-hidden />
              </a>
            </p>
          )}
          {bot.allowedOrigins.length === 0 && (
            <div className="mt-3">
              <Alert tone="info">
                Add the website addresses below first. For security, the bubble only appears on domains you
                list.
              </Alert>
            </div>
          )}
          <h3 className="mt-5 text-sm font-medium">Shareable chat page</h3>
          <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
            <code className="min-w-0 flex-1 truncate rounded-lg bg-surface-2 p-2.5 text-xs">{hostedUrl}</code>
            <div className="flex gap-2">
              <CopyButton text={hostedUrl} label="Copy chat page link" />
              <a
                href={hostedUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 rounded-lg border border-border px-3 py-2 text-sm hover:bg-surface-2"
              >
                <ExternalLink className="size-4" aria-hidden /> Open
              </a>
            </div>
          </div>
        </Card>

        <form
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            setError(undefined);
            save.mutate();
          }}
        >
          <fieldset disabled={!editable} className="flex flex-col gap-6">
            <Card className="flex flex-col gap-4 p-5">
              <h2 className="font-semibold">Where it can appear</h2>
              <Field
                label="Allowed websites"
                htmlFor="domains"
                hint="One per line, e.g. https://www.example.com. Use https://*.example.com for all subdomains. Browsers block the chat everywhere else. Files opened from your computer (file://) can't show the bubble: use the test page above, or a local server such as http://localhost:8080."
              >
                <textarea
                  id="domains"
                  rows={3}
                  value={domains}
                  onChange={(e) => setDomains(e.target.value)}
                  placeholder="https://www.example.com"
                  className="w-full rounded-lg border border-border bg-surface px-3 py-2 font-mono text-sm text-fg focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/40"
                />
              </Field>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="accent-[var(--accent)]"
                  checked={widgetEnabled}
                  onChange={(e) => setWidgetEnabled(e.target.checked)}
                />
                Chat bubble on websites
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="accent-[var(--accent)]"
                  checked={hostedPageEnabled}
                  onChange={(e) => setHostedPageEnabled(e.target.checked)}
                />
                Shareable chat page
              </label>
            </Card>

            <Card className="grid gap-4 p-5 sm:grid-cols-2">
              <h2 className="font-semibold sm:col-span-2">Look and feel</h2>
              <Field label="Title" htmlFor="b-title">
                <Input
                  id="b-title"
                  maxLength={60}
                  placeholder={bot.name}
                  value={branding.title}
                  onChange={(e) => set({ title: e.target.value })}
                />
              </Field>
              <Field label="Brand colour" htmlFor="b-color">
                <div className="flex items-center gap-2">
                  <input
                    id="b-color"
                    type="color"
                    value={branding.primaryColor}
                    onChange={(e) => set({ primaryColor: e.target.value })}
                    className="h-9 w-12 cursor-pointer rounded border border-border bg-surface"
                  />
                  <Input
                    aria-label="Brand colour hex"
                    value={branding.primaryColor}
                    onChange={(e) => set({ primaryColor: e.target.value })}
                    className="w-28 font-mono"
                  />
                </div>
              </Field>
              <div className="sm:col-span-2">
                <Field label="Greeting" htmlFor="b-greeting">
                  <Input
                    id="b-greeting"
                    maxLength={300}
                    placeholder="Hi! Ask me anything about…"
                    value={branding.greeting}
                    onChange={(e) => set({ greeting: e.target.value })}
                  />
                </Field>
              </div>
              <div className="sm:col-span-2">
                <Field label="Logo (optional)" htmlFor="b-logo" hint="An https:// link to a square image.">
                  <Input
                    id="b-logo"
                    type="url"
                    placeholder="https://www.example.com/logo.png"
                    value={branding.logoUrl}
                    onChange={(e) => set({ logoUrl: e.target.value })}
                  />
                </Field>
              </div>
              <fieldset className="sm:col-span-2">
                <legend className="mb-1.5 text-sm font-medium">Suggested questions</legend>
                <div className="grid gap-2 sm:grid-cols-2">
                  {questions.map((q, i) => (
                    <Input
                      // biome-ignore lint/suspicious/noArrayIndexKey: fixed set of four slots
                      key={i}
                      aria-label={`Suggested question ${i + 1}`}
                      maxLength={120}
                      value={q}
                      onChange={(e) => {
                        const next = [...questions];
                        next[i] = e.target.value;
                        set({ suggestedQuestions: next });
                      }}
                    />
                  ))}
                </div>
              </fieldset>
              <Field label="Position" htmlFor="b-position">
                <Select
                  id="b-position"
                  value={branding.position}
                  onChange={(e) => set({ position: e.target.value as BotBranding["position"] })}
                >
                  <option value="bottom-right">Bottom right</option>
                  <option value="bottom-left">Bottom left</option>
                </Select>
              </Field>
              <Field label="Theme" htmlFor="b-theme">
                <Select
                  id="b-theme"
                  value={branding.theme}
                  onChange={(e) => set({ theme: e.target.value as BotBranding["theme"] })}
                >
                  <option value="auto">Match the visitor's device</option>
                  <option value="light">Light</option>
                  <option value="dark">Dark</option>
                </Select>
              </Field>
            </Card>

            <Card className="flex flex-col gap-3 p-5">
              <h2 className="font-semibold">Usage limit</h2>
              <p className="text-sm text-muted">
                {bot.publicAnswersThisMonth.toLocaleString()} answers to website visitors this month
                {bot.monthlyMessageCap ? ` of ${bot.monthlyMessageCap.toLocaleString()} allowed` : ""}. Each
                answer uses your model provider's API credit.
              </p>
              <Field
                label="Monthly answer limit"
                htmlFor="b-cap"
                hint="Leave empty for no limit. When reached, the chat says it's unavailable until next month."
              >
                <Input
                  id="b-cap"
                  type="number"
                  min={1}
                  value={cap}
                  onChange={(e) => setCap(e.target.value)}
                  className="w-40"
                  placeholder="No limit"
                />
              </Field>
            </Card>

            {error && <Alert tone="danger">{error}</Alert>}
            {editable && (
              <div>
                <Button type="submit" loading={save.isPending}>
                  Save changes
                </Button>
              </div>
            )}
          </fieldset>
        </form>
      </div>

      <div className="h-fit xl:sticky xl:top-6">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold">Preview</h2>
          <Button variant="ghost" onClick={() => setPreviewKey((k) => k + 1)} aria-label="Reload preview">
            <RefreshCw className="size-4" aria-hidden />
          </Button>
        </div>
        {bot.widgetEnabled ? (
          <iframe
            key={previewKey}
            title="Chat preview"
            src={`/w/${bot.publicKey}`}
            className="h-[600px] w-full rounded-2xl border border-border bg-surface shadow-lg"
          />
        ) : (
          <Card className="p-6 text-sm text-muted">The chat bubble is turned off.</Card>
        )}
        <p className="mt-2 text-xs text-muted">
          This is the live assistant: preview answers are real and count towards usage.
        </p>
      </div>
    </div>
  );
}
