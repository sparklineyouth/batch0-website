"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input, Textarea, Label } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Send, FlaskConical, Users, CheckCheck, X } from "lucide-react";
import type { BlastRecipient } from "./page";
import {
  renderBlastPreview,
  sendTestBlast,
  sendBlast,
  type BlastDraft,
  type BlastSendResult,
} from "./actions";

// Quick audience presets. "Accepted" = admitted but not yet paid — the
// group you most often need to nudge.
const AUDIENCES = [
  { key: "students", label: "Students" },
  { key: "enrolled", label: "Enrolled" },
  { key: "accepted", label: "Accepted (unpaid)" },
  { key: "applied", label: "Applied" },
  { key: "everyone", label: "Everyone" },
] as const;
type AudienceKey = (typeof AUDIENCES)[number]["key"];

// Compose starting points. Subject/body land in editable fields, so
// these are prompts, not locked templates.
function templates(siteUrl: string) {
  return [
    {
      key: "blank",
      label: "Blank",
      subject: "",
      body: "Hi {{name}},\n\n",
      ctaLabel: "",
      ctaUrl: "",
    },
    {
      key: "announcement",
      label: "Announcement",
      subject: "An update from Sparkline Youth",
      body: "Hi {{name}},\n\nWe've got news to share:\n\n[Write your announcement here.]\n\n— The Sparkline Youth team",
      ctaLabel: "Open dashboard",
      ctaUrl: `${siteUrl}/dashboard`,
    },
    {
      key: "event",
      label: "Event reminder",
      subject: "Coming up: [event name]",
      body: "Hi {{name}},\n\nQuick reminder — [event name] is happening [day/time]. Don't miss it.\n\nSee you there,\nThe Sparkline Youth team",
      ctaLabel: "View events",
      ctaUrl: `${siteUrl}/dashboard/events`,
    },
    {
      key: "nudge",
      label: "Application nudge",
      subject: "Finish your Sparkline Youth application",
      body: "Hi {{name}},\n\nYou started an application but haven't submitted it yet. Seats are limited and reviews are rolling — a few minutes now keeps your spot in the running.\n\n— The Sparkline Youth team",
      ctaLabel: "Continue application",
      ctaUrl: `${siteUrl}/apply`,
    },
  ];
}

export function BlastForm({
  recipients,
  siteUrl,
}: {
  recipients: BlastRecipient[];
  siteUrl: string;
}) {
  // ---- recipient selection ----
  const [audience, setAudience] = useState<AudienceKey>("students");
  const [cohort, setCohort] = useState<string>("");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const cohortNames = useMemo(
    () =>
      Array.from(new Set(recipients.flatMap((r) => r.cohorts))).sort(),
    [recipients],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return recipients.filter((r) => {
      if (audience === "students" && r.role !== "student") return false;
      if (audience === "enrolled" && r.cohorts.length === 0) return false;
      if (audience === "accepted" && r.appStatus !== "accepted") return false;
      if (audience === "applied" && r.appStatus !== "submitted") return false;
      if (cohort && !r.cohorts.includes(cohort)) return false;
      if (
        q &&
        !(r.name ?? "").toLowerCase().includes(q) &&
        !r.email.toLowerCase().includes(q)
      )
        return false;
      return true;
    });
  }, [recipients, audience, cohort, search]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function selectFiltered() {
    setSelected((prev) => {
      const next = new Set(prev);
      filtered.forEach((r) => next.add(r.id));
      return next;
    });
  }

  // ---- compose ----
  const TEMPLATES = useMemo(() => templates(siteUrl), [siteUrl]);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("Hi {{name}},\n\n");
  const [ctaLabel, setCtaLabel] = useState("");
  const [ctaUrl, setCtaUrl] = useState("");

  function applyTemplate(key: string) {
    const t = TEMPLATES.find((t) => t.key === key);
    if (!t) return;
    setSubject(t.subject);
    setBody(t.body);
    setCtaLabel(t.ctaLabel);
    setCtaUrl(t.ctaUrl);
  }

  const draft: BlastDraft = { subject, body, ctaLabel, ctaUrl };

  // ---- live preview (debounced server render so preview === send) ----
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  const previewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (previewTimer.current) clearTimeout(previewTimer.current);
    if (!subject.trim() || !body.trim()) {
      setPreviewHtml(null);
      return;
    }
    previewTimer.current = setTimeout(async () => {
      const res = await renderBlastPreview({
        subject,
        body,
        ctaLabel,
        ctaUrl,
      });
      if (res.ok) setPreviewHtml(res.html);
    }, 600);
    return () => {
      if (previewTimer.current) clearTimeout(previewTimer.current);
    };
  }, [subject, body, ctaLabel, ctaUrl]);

  // ---- test + send ----
  const [testState, setTestState] = useState<{
    busy: boolean;
    message?: string;
    ok?: boolean;
  }>({ busy: false });
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<BlastSendResult | null>(null);

  const composeValid = subject.trim().length > 0 && body.trim().length > 0;

  async function onTest() {
    setTestState({ busy: true });
    const res = await sendTestBlast(draft);
    setTestState({ busy: false, message: res.message, ok: res.ok });
  }

  async function onSend() {
    setSending(true);
    setResult(null);
    const res = await sendBlast(Array.from(selected), draft);
    setResult(res);
    setSending(false);
    setConfirming(false);
    if (res.ok) setSelected(new Set());
  }

  return (
    <div className="mt-8 grid gap-6 lg:grid-cols-2">
      {/* ---------------- recipients ---------------- */}
      <Card className="lg:sticky lg:top-6 self-start">
        <div className="flex items-center justify-between gap-3">
          <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-ink-soft">
            <Users className="h-4 w-4" /> Recipients
          </h2>
          <span className="rounded-full border border-spark/40 bg-spark/10 px-2.5 py-0.5 text-xs font-medium tabular-nums text-spark-ink">
            {selected.size} selected
          </span>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          {AUDIENCES.map((a) => (
            <button
              key={a.key}
              type="button"
              onClick={() => setAudience(a.key)}
              className={`rounded-full border px-3 py-1 text-xs transition ${
                audience === a.key
                  ? "border-spark bg-spark/10 text-spark-ink"
                  : "border-line text-ink-soft hover:border-ink/30 hover:text-ink"
              }`}
            >
              {a.label}
            </button>
          ))}
        </div>

        <div className="mt-3 flex gap-2">
          <Input
            placeholder="Search name or email…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {cohortNames.length > 0 && (
            <select
              value={cohort}
              onChange={(e) => setCohort(e.target.value)}
              className="h-10 rounded-md border border-line bg-paper px-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-spark/60"
            >
              <option value="">Any cohort</option>
              {cohortNames.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          )}
        </div>

        <div className="mt-3 flex items-center gap-2 text-xs">
          <button
            type="button"
            onClick={selectFiltered}
            className="inline-flex items-center gap-1 rounded-md border border-line bg-wash px-2.5 py-1 font-medium text-ink-soft hover:border-ink/30 hover:bg-wash"
          >
            <CheckCheck className="h-3.5 w-3.5" />
            Select all {filtered.length} shown
          </button>
          {selected.size > 0 && (
            <button
              type="button"
              onClick={() => setSelected(new Set())}
              className="inline-flex items-center gap-1 rounded-md border border-line bg-wash px-2.5 py-1 font-medium text-ink-soft hover:border-ink/30 hover:bg-wash"
            >
              <X className="h-3.5 w-3.5" />
              Clear
            </button>
          )}
        </div>

        <ul className="mt-3 max-h-80 divide-y divide-line overflow-y-auto rounded-lg border border-line">
          {filtered.length === 0 && (
            <li className="p-4 text-sm text-ink-faint">
              No one matches this filter.
            </li>
          )}
          {filtered.map((r) => (
            <li key={r.id}>
              <label className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-wash">
                <input
                  type="checkbox"
                  checked={selected.has(r.id)}
                  onChange={() => toggle(r.id)}
                  className="h-4 w-4 accent-[#facc15]"
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-ink">
                    {r.name || r.email}
                  </span>
                  <span className="block truncate text-xs text-ink-faint">
                    {r.email}
                    {r.appStatus ? ` · ${r.appStatus}` : ""}
                    {r.cohorts.length > 0 ? ` · ${r.cohorts.join(", ")}` : ""}
                  </span>
                </span>
                {r.role !== "student" && (
                  <span className="rounded border border-line px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-ink-faint">
                    {r.role}
                  </span>
                )}
              </label>
            </li>
          ))}
        </ul>
      </Card>

      {/* ---------------- compose ---------------- */}
      <div className="space-y-6">
        <Card>
          <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-soft">
            Compose
          </h2>
          <div className="mt-4 flex flex-wrap gap-2">
            {TEMPLATES.map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => applyTemplate(t.key)}
                className="rounded-full border border-line px-3 py-1 text-xs text-ink-soft transition hover:border-spark/50 hover:text-spark-ink"
              >
                {t.label}
              </button>
            ))}
          </div>
          <div className="mt-4 space-y-4">
            <div>
              <Label htmlFor="blast-subject" required>
                Subject
              </Label>
              <Input
                id="blast-subject"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder="Subject line"
              />
            </div>
            <div>
              <Label htmlFor="blast-body" required>
                Body
              </Label>
              <Textarea
                id="blast-body"
                rows={9}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder={"Hi {{name}},\n\nYour message…"}
              />
              <p className="mt-1 text-xs text-ink-faint">
                Plain text. Blank line = new paragraph.{" "}
                <code className="rounded bg-wash px-1 font-mono">
                  {"{{name}}"}
                </code>{" "}
                becomes each recipient&apos;s first name.
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label htmlFor="blast-cta-label">Button label (optional)</Label>
                <Input
                  id="blast-cta-label"
                  value={ctaLabel}
                  onChange={(e) => setCtaLabel(e.target.value)}
                  placeholder="Open dashboard"
                />
              </div>
              <div>
                <Label htmlFor="blast-cta-url">Button URL</Label>
                <Input
                  id="blast-cta-url"
                  value={ctaUrl}
                  onChange={(e) => setCtaUrl(e.target.value)}
                  placeholder={`${siteUrl}/dashboard`}
                />
              </div>
            </div>
          </div>
        </Card>

        <Card>
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-soft">
              Preview
            </h2>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={onTest}
              disabled={!composeValid || testState.busy}
            >
              <FlaskConical className="h-3.5 w-3.5" />
              {testState.busy ? "Sending…" : "Send test to me"}
            </Button>
          </div>
          {testState.message && (
            <p
              className={`mt-2 text-xs ${
                testState.ok ? "text-emerald-700 dark:text-emerald-300" : "text-red-700 dark:text-red-300"
              }`}
            >
              {testState.message}
            </p>
          )}
          {previewHtml ? (
            <iframe
              title="Email preview"
              sandbox=""
              srcDoc={previewHtml}
              className="mt-4 h-[420px] w-full rounded-lg border border-line bg-paper"
            />
          ) : (
            <p className="mt-4 rounded-lg border border-dashed border-line p-8 text-center text-sm text-ink-faint">
              Fill in a subject and body to see the branded preview.
            </p>
          )}
        </Card>

        {/* ---------------- send ---------------- */}
        <Card>
          {result && result.ok && (
            <div className="mb-4 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3 text-sm text-emerald-700 dark:text-emerald-200">
              Sent to {result.sent} recipient{result.sent === 1 ? "" : "s"}.
              {result.failed.length > 0 && (
                <div className="mt-2 text-red-700 dark:text-red-300">
                  {result.failed.length} failed:
                  <ul className="mt-1 list-inside list-disc text-xs">
                    {result.failed.slice(0, 10).map((f) => (
                      <li key={f.to}>
                        {f.to} — {f.reason}
                      </li>
                    ))}
                    {result.failed.length > 10 && (
                      <li>…and {result.failed.length - 10} more</li>
                    )}
                  </ul>
                </div>
              )}
            </div>
          )}
          {result && !result.ok && (
            <div className="mb-4 rounded-lg border border-red-500/30 bg-red-500/5 p-3 text-sm text-red-700 dark:text-red-300">
              {result.error}
            </div>
          )}

          {!confirming ? (
            <Button
              type="button"
              className="w-full"
              disabled={!composeValid || selected.size === 0 || sending}
              onClick={() => setConfirming(true)}
            >
              <Send className="h-4 w-4" />
              Send to {selected.size} recipient{selected.size === 1 ? "" : "s"}
            </Button>
          ) : (
            <div className="flex items-center gap-3">
              <Button
                type="button"
                className="flex-1"
                disabled={sending}
                onClick={onSend}
              >
                {sending
                  ? "Sending…"
                  : `Yes — email ${selected.size} ${selected.size === 1 ? "person" : "people"} now`}
              </Button>
              <Button
                type="button"
                variant="secondary"
                disabled={sending}
                onClick={() => setConfirming(false)}
              >
                Cancel
              </Button>
            </div>
          )}
          <p className="mt-2 text-center text-xs text-ink-faint">
            Emails send from your Resend account with the Sparkline template.
            There&apos;s no undo — send a test first.
          </p>
        </Card>
      </div>
    </div>
  );
}
