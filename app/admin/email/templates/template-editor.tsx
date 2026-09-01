"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Send, Trash2, History, Save, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Textarea, Label, Select, FieldError } from "@/components/ui/input";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Card } from "@/components/ui/card";
import { LocalTime } from "@/components/ui/local-time";
import { RichTextEditor } from "@/components/admin/rich-text-editor";
import { getActionError } from "@/lib/action-error";
import { extractTags, type VariableDef } from "@/lib/email/vars";
import {
  TEMPLATE_CATEGORIES,
  COMMON_VARIABLES,
  slugifyTemplateKey,
} from "@/lib/email/catalog";
import {
  saveTemplate,
  deleteTemplate,
  previewTemplate,
  sendTestTemplate,
  restoreTemplateVersion,
  type TemplateInput,
} from "./actions";

export type VersionSummary = {
  id: string;
  version: number;
  created_at: string;
};

/**
 * The template editor.
 *
 * Laid out as write-on-the-left, see-it-on-the-right because the thing an
 * admin is actually deciding here is how the email *reads* — subject line
 * against body, where the button falls, whether the greeting works when the
 * name is missing. A tabbed preview hides exactly the comparison they need to
 * make.
 */
export function TemplateEditor({
  initial,
  isSystem,
  versions = [],
  usedByAutomations = 0,
}: {
  initial: TemplateInput;
  isSystem: boolean;
  versions?: VersionSummary[];
  usedByAutomations?: number;
}) {
  const router = useRouter();
  const [v, setV] = useState<TemplateInput>(initial);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(
    Boolean(initial.fromEmail || initial.replyTo),
  );
  const [testTo, setTestTo] = useState("");
  const [keyTouched, setKeyTouched] = useState(Boolean(initial.id));

  const [previewHtml, setPreviewHtml] = useState("");
  const [previewing, setPreviewing] = useState(false);

  function set<K extends keyof TemplateInput>(k: K, val: TemplateInput[K]) {
    setV((p) => ({ ...p, [k]: val }));
    setNotice(undefined);
  }

  /**
   * Every tag the copy actually uses, whether or not it's declared. This is
   * what the "undeclared variable" warning keys off — a typo'd `{{frist_name}}`
   * looks perfectly fine in the editor and ships a broken greeting, and it's
   * the single most common way a template goes out wrong.
   */
  const usedTags = useMemo(
    () => extractTags(v.subject, v.preheader, v.bodyHtml, v.ctaUrl, v.ctaLabel),
    [v.subject, v.preheader, v.bodyHtml, v.ctaUrl, v.ctaLabel],
  );
  const declaredKeys = useMemo(
    () => new Set(v.variables.map((x) => x.key)),
    [v.variables],
  );
  const undeclared = usedTags.filter((t) => !declaredKeys.has(t));

  // The insert menu offers what's declared, plus the ones every template can
  // rely on — an admin shouldn't have to declare {{first_name}} to use it.
  const insertable: VariableDef[] = useMemo(() => {
    const out = [...v.variables];
    for (const c of COMMON_VARIABLES) {
      if (!out.some((x) => x.key === c.key)) out.push(c);
    }
    return out;
  }, [v.variables]);

  // Debounced preview through the real server renderer, so what's on screen
  // went through the same sanitize → interpolate → wrap path as a real send.
  const draftRef = useRef(v);
  draftRef.current = v;
  useEffect(() => {
    let cancelled = false;
    setPreviewing(true);
    const t = setTimeout(async () => {
      try {
        const res = await previewTemplate(draftRef.current);
        if (!cancelled && res.ok) setPreviewHtml(res.html);
      } catch {
        /* preview is best-effort */
      } finally {
        if (!cancelled) setPreviewing(false);
      }
    }, 450);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [v.subject, v.preheader, v.bodyHtml, v.ctaLabel, v.ctaUrl, v.variables]);

  function onSave() {
    setError(undefined);
    start(async () => {
      try {
        const res = await saveTemplate(v);
        if (!res.ok) {
          setError(res.error);
          return;
        }
        setNotice("Saved.");
        if (!v.id) router.replace(`/admin/email/templates/${res.id}`);
        else router.refresh();
      } catch (err) {
        setError(getActionError(err));
      }
    });
  }

  function onTest() {
    setError(undefined);
    setNotice(undefined);
    start(async () => {
      try {
        const res = await sendTestTemplate(v, testTo);
        if (res.ok) setNotice(res.message);
        else setError(res.message);
      } catch (err) {
        setError(getActionError(err));
      }
    });
  }

  function onDelete() {
    start(async () => {
      try {
        const res = await deleteTemplate(v.id!);
        if (!res.ok) {
          setError(res.error);
          setConfirmDelete(false);
          return;
        }
        router.push("/admin/email/templates");
      } catch (err) {
        setError(getActionError(err));
        setConfirmDelete(false);
      }
    });
  }

  function onRestore(versionId: string) {
    start(async () => {
      try {
        const res = await restoreTemplateVersion(v.id!, versionId);
        if (!res.ok) setError(res.error);
        else router.refresh();
      } catch (err) {
        setError(getActionError(err));
      }
    });
  }

  return (
    <div className="mx-auto max-w-[1400px]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Link
            href="/admin/email/templates"
            className="inline-flex items-center gap-1.5 text-sm text-ink-soft hover:text-ink"
          >
            <ArrowLeft className="h-4 w-4" /> All templates
          </Link>
          <h1 className="mt-2 font-display text-3xl font-bold tracking-[-0.02em] text-ink">
            {v.id ? v.name || "Untitled template" : "New template"}
          </h1>
          <p className="mt-1 font-mono text-xs text-ink-faint">{v.key || "—"}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            role="switch"
            aria-checked={v.enabled}
            onClick={() => set("enabled", !v.enabled)}
            className={`inline-flex h-10 items-center gap-2 rounded-md border px-3 text-sm font-medium transition-none active:scale-[0.98] ${
              v.enabled
                ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                : "border-line bg-wash text-ink-faint"
            }`}
          >
            <span
              className={`h-2 w-2 rounded-full ${v.enabled ? "bg-emerald-500" : "bg-ink-faint"}`}
              aria-hidden
            />
            {v.enabled ? "Active" : "Disabled"}
          </button>
          {v.id && !isSystem && (
            <Button
              variant="danger"
              size="sm"
              onClick={() => setConfirmDelete(true)}
              disabled={pending}
            >
              <Trash2 className="h-4 w-4" /> Delete
            </Button>
          )}
          <Button onClick={onSave} disabled={pending}>
            <Save className="h-4 w-4" /> {pending ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>

      {isSystem && (
        <Card className="mt-5 border-amber-500/30 bg-amber-500/5">
          <p className="text-sm text-ink-soft">
            <strong className="text-ink">Built-in template.</strong> The app sends
            this one by name, so its key is fixed and it can't be deleted. Edit
            the copy freely — turning it off doesn't stop the email, it falls
            back to the original wording shipped in the code.
          </p>
        </Card>
      )}

      {!v.enabled && !isSystem && (
        <Card className="mt-5 border-line bg-wash">
          <p className="text-sm text-ink-soft">
            This template is disabled. Automation steps pointing at it will skip
            rather than send.
          </p>
        </Card>
      )}

      {usedByAutomations > 0 && (
        <Card className="mt-5">
          <p className="text-sm text-ink-soft">
            Used by {usedByAutomations} automation step
            {usedByAutomations === 1 ? "" : "s"}. Edits apply to mail that hasn't
            gone out yet, including anything already queued.{" "}
            <Link href="/admin/email/automations" className="text-phosphor-ink underline">
              See automations
            </Link>
          </p>
        </Card>
      )}

      {error && (
        <div className="mt-5 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-700 dark:text-red-300">
          {error}
        </div>
      )}
      {notice && (
        <div className="mt-5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-700 dark:text-emerald-300">
          {notice}
        </div>
      )}

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_460px]">
        {/* ---- Write ---- */}
        <div className="space-y-5">
          <Card className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Label htmlFor="tpl-name">Name</Label>
                <Input
                  id="tpl-name"
                  value={v.name}
                  onChange={(e) => {
                    const name = e.target.value;
                    setV((p) => ({
                      ...p,
                      name,
                      key: keyTouched || isSystem ? p.key : slugifyTemplateKey(name),
                    }));
                  }}
                  placeholder="Payment nudge"
                />
              </div>
              <div>
                <Label htmlFor="tpl-key">Key</Label>
                <Input
                  id="tpl-key"
                  value={v.key}
                  disabled={isSystem}
                  onChange={(e) => {
                    setKeyTouched(true);
                    set("key", e.target.value);
                  }}
                  placeholder="nudge.unpaid"
                  className="font-mono text-xs"
                />
                <p className="mt-1 text-xs text-ink-faint">
                  {isSystem
                    ? "Fixed — the app sends this template by key."
                    : "How code and automations refer to this template."}
                </p>
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Label htmlFor="tpl-category">Category</Label>
                <Select
                  id="tpl-category"
                  value={v.category}
                  onChange={(e) => set("category", e.target.value)}
                >
                  {TEMPLATE_CATEGORIES.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label}
                    </option>
                  ))}
                </Select>
              </div>
              <div>
                <Label htmlFor="tpl-desc">Internal note</Label>
                <Input
                  id="tpl-desc"
                  value={v.description}
                  onChange={(e) => set("description", e.target.value)}
                  placeholder="When this goes out, and to whom"
                />
              </div>
            </div>
          </Card>

          <Card className="space-y-4">
            <div>
              <Label htmlFor="tpl-subject">Subject</Label>
              <Input
                id="tpl-subject"
                value={v.subject}
                onChange={(e) => set("subject", e.target.value)}
                placeholder="Your batch0 seat is still open"
              />
            </div>
            <div>
              <Label htmlFor="tpl-preheader">Preview text</Label>
              <Input
                id="tpl-preheader"
                value={v.preheader}
                onChange={(e) => set("preheader", e.target.value)}
                placeholder="The grey line the inbox shows after the subject"
              />
            </div>

            <div>
              <Label>Body</Label>
              <RichTextEditor
                value={v.bodyHtml}
                onChange={(html) => set("bodyHtml", html)}
                variables={insertable}
                placeholder="Hi {{first_name}}, …"
              />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Label htmlFor="tpl-cta-label">Button label</Label>
                <Input
                  id="tpl-cta-label"
                  value={v.ctaLabel}
                  onChange={(e) => set("ctaLabel", e.target.value)}
                  placeholder="Finish enrolling"
                />
              </div>
              <div>
                <Label htmlFor="tpl-cta-url">Button URL</Label>
                <Input
                  id="tpl-cta-url"
                  value={v.ctaUrl}
                  onChange={(e) => set("ctaUrl", e.target.value)}
                  placeholder="{{site_url}}/dashboard/accepted"
                  className="font-mono text-xs"
                />
              </div>
            </div>
            {(v.ctaLabel || v.ctaUrl) && !(v.ctaLabel && v.ctaUrl) && (
              <FieldError>Give the button both a label and a URL, or neither.</FieldError>
            )}
          </Card>

          <VariablesCard
            variables={v.variables}
            undeclared={undeclared}
            onChange={(next) => set("variables", next)}
          />

          <Card>
            <button
              type="button"
              onClick={() => setShowAdvanced((s) => !s)}
              className="text-sm font-semibold text-ink-soft hover:text-ink"
            >
              {showAdvanced ? "Hide" : "Show"} sender overrides
            </button>
            {showAdvanced && (
              <div className="mt-4 grid gap-4 sm:grid-cols-3">
                <div>
                  <Label htmlFor="tpl-from-name">From name</Label>
                  <Input
                    id="tpl-from-name"
                    value={v.fromName}
                    onChange={(e) => set("fromName", e.target.value)}
                    placeholder="batch0"
                  />
                </div>
                <div>
                  <Label htmlFor="tpl-from-email">From address</Label>
                  <Input
                    id="tpl-from-email"
                    value={v.fromEmail}
                    onChange={(e) => set("fromEmail", e.target.value)}
                    placeholder="billing@batch0.org"
                  />
                </div>
                <div>
                  <Label htmlFor="tpl-reply-to">Reply-to</Label>
                  <Input
                    id="tpl-reply-to"
                    value={v.replyTo}
                    onChange={(e) => set("replyTo", e.target.value)}
                    placeholder="hello@batch0.org"
                  />
                </div>
                <p className="text-xs text-ink-faint sm:col-span-3">
                  Leave blank to use the addresses set at{" "}
                  <Link href="/admin/email/settings" className="underline">
                    email settings
                  </Link>
                  . A From address on a domain the transport hasn't verified will
                  bounce or land in spam.
                </p>
              </div>
            )}
          </Card>
        </div>

        {/* ---- See ---- */}
        <div className="space-y-5 lg:sticky lg:top-6 lg:self-start">
          <Card className="!p-0 overflow-hidden">
            <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
              <span className="text-xs font-semibold uppercase tracking-wider text-ink-faint">
                Preview
              </span>
              {previewing && <span className="text-xs text-ink-faint">rendering…</span>}
            </div>
            <div className="bg-[#0a0a0a] p-2">
              {/*
                An iframe, not a div: the email body carries its own inline
                styles and a dark shell, and dropping that into the admin page
                would inherit the panel's cascade and show something the
                recipient will never see.
              */}
              <iframe
                title="Email preview"
                srcDoc={previewHtml}
                sandbox=""
                className="h-[620px] w-full rounded-lg border-0 bg-[#0a0a0a]"
              />
            </div>
          </Card>

          <Card className="space-y-3">
            <Label htmlFor="tpl-test-to">Send a test</Label>
            <div className="flex gap-2">
              <Input
                id="tpl-test-to"
                value={testTo}
                onChange={(e) => setTestTo(e.target.value)}
                placeholder="your@email.com (defaults to you)"
                type="email"
              />
              <Button variant="secondary" onClick={onTest} disabled={pending}>
                <Send className="h-4 w-4" /> Test
              </Button>
            </div>
            <p className="text-xs text-ink-faint">
              A real send through the live transport, with sample values filled
              in. The only way to see what a client actually does with it.
            </p>
          </Card>

          {versions.length > 0 && (
            <Card className="!p-0 overflow-hidden">
              <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
                <History className="h-3.5 w-3.5 text-ink-faint" />
                <span className="text-xs font-semibold uppercase tracking-wider text-ink-faint">
                  History
                </span>
              </div>
              <ul className="max-h-64 overflow-y-auto">
                {versions.map((ver) => (
                  <li
                    key={ver.id}
                    className="flex items-center justify-between border-b border-line px-4 py-2 last:border-0"
                  >
                    <span className="text-sm text-ink-soft">
                      v{ver.version} ·{" "}
                      <LocalTime value={ver.created_at} mode="datetime-short" />
                    </span>
                    <button
                      type="button"
                      onClick={() => onRestore(ver.id)}
                      disabled={pending}
                      className="text-xs font-semibold text-phosphor-ink hover:underline disabled:opacity-50"
                    >
                      Restore
                    </button>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={onDelete}
        title="Delete this template?"
        description="The copy and its version history go with it. Automations using it must be updated first."
        confirmLabel="Delete"
        pending={pending}
        destructive
      />
    </div>
  );
}

/**
 * Declared variables.
 *
 * Declaring is optional — an undeclared tag still interpolates — but it buys
 * two things worth having: an entry in the editor's insert menu, and the
 * `required` flag, which is what stops a template with a hole in it going out
 * at all.
 */
function VariablesCard({
  variables,
  undeclared,
  onChange,
}: {
  variables: VariableDef[];
  undeclared: string[];
  onChange: (next: VariableDef[]) => void;
}) {
  function update(i: number, patch: Partial<VariableDef>) {
    onChange(variables.map((v, idx) => (idx === i ? { ...v, ...patch } : v)));
  }

  return (
    <Card className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <Label>Variables</Label>
          <p className="text-xs text-ink-faint">
            Merge tags this template expects. Declaring one adds it to the
            insert menu and gives it a sample value in the preview.
          </p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          onClick={() =>
            onChange([...variables, { key: "", label: "", example: "" }])
          }
        >
          Add
        </Button>
      </div>

      {undeclared.length > 0 && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-ink-soft">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
          <span>
            Used but not declared:{" "}
            {undeclared.map((t) => (
              <code key={t} className="mr-1 font-mono text-phosphor-ink">
                {`{{${t}}}`}
              </code>
            ))}
            — these still work if the sender supplies them, but a typo here goes
            out as literal braces in the email.{" "}
            <button
              type="button"
              className="font-semibold underline"
              onClick={() =>
                onChange([
                  ...variables,
                  ...undeclared.map((k) => ({ key: k, label: k, example: "" })),
                ])
              }
            >
              Declare them all
            </button>
          </span>
        </div>
      )}

      {variables.length === 0 ? (
        <p className="text-sm text-ink-faint">No variables declared.</p>
      ) : (
        <div className="space-y-2">
          {variables.map((v, i) => (
            <div key={i} className="grid gap-2 sm:grid-cols-[1fr_1fr_1fr_auto_auto]">
              <Input
                value={v.key}
                onChange={(e) => update(i, { key: e.target.value })}
                placeholder="cohort_name"
                className="font-mono text-xs"
                aria-label="Variable key"
              />
              <Input
                value={v.label}
                onChange={(e) => update(i, { label: e.target.value })}
                placeholder="Cohort name"
                aria-label="Variable label"
              />
              <Input
                value={v.example}
                onChange={(e) => update(i, { example: e.target.value })}
                placeholder="Cohort 1"
                aria-label="Example value"
              />
              <label className="flex items-center gap-1.5 whitespace-nowrap px-1 text-xs text-ink-soft">
                <input
                  type="checkbox"
                  checked={Boolean(v.required)}
                  onChange={(e) => update(i, { required: e.target.checked })}
                  className="h-3.5 w-3.5 accent-phosphor"
                />
                Required
              </label>
              <button
                type="button"
                onClick={() => onChange(variables.filter((_, idx) => idx !== i))}
                className="px-2 text-ink-faint hover:text-red-500"
                aria-label={`Remove ${v.key || "variable"}`}
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
          <p className="text-xs text-ink-faint">
            A required variable with no value blocks the send and falls back to
            the built-in copy — better a plain email than one with a gap in the
            middle of a sentence.
          </p>
        </div>
      )}
    </Card>
  );
}
