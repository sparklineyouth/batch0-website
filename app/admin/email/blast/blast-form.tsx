"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input, Textarea, Label } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Send, FlaskConical, Users, CheckCheck, X } from "lucide-react";
import {
  getRecipients,
  renderBlastPreview,
  sendTestBlast,
  sendBlast,
  type BlastDraft,
  type BlastRecipient,
  type BlastSendResult,
} from "./actions";
import {
  buildEnvelopes,
  type BlastAudience,
  type BlastVariant,
} from "./shared";

// Quick audience presets. "Accepted" = admitted but not yet paid — the
// group you most often need to nudge.
const AUDIENCES = [
  { key: "students", label: "Students" },
  { key: "enrolled", label: "Enrolled" },
  { key: "accepted", label: "Accepted (unpaid)" },
  { key: "waitlisted", label: "Waitlisted" },
  { key: "applied", label: "Applied" },
  { key: "everyone", label: "Everyone" },
] as const;
type AudienceKey = (typeof AUDIENCES)[number]["key"];

// Which addresses the chosen filter resolves to. Orthogonal to the filter
// pills above: pick the people with those, pick their inboxes with this.
const SEND_TO: { key: BlastAudience; label: string; hint: string }[] = [
  { key: "students", label: "Students", hint: "Their own address." },
  {
    key: "parents",
    label: "Parents",
    hint: "The parent / guardian address from their application.",
  },
  { key: "both", label: "Both", hint: "Student and parent, deduplicated." },
];

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
      subject: "An update from batch0",
      body: "Hi {{name}},\n\nWe've got news to share:\n\n[Write your announcement here.]\n\n— The batch0 team",
      ctaLabel: "Open dashboard",
      ctaUrl: `${siteUrl}/dashboard`,
    },
    {
      key: "event",
      label: "Event reminder",
      subject: "Coming up: [event name]",
      body: "Hi {{name}},\n\nQuick reminder — [event name] is happening [day/time]. Don't miss it.\n\nSee you there,\nThe batch0 team",
      ctaLabel: "View events",
      ctaUrl: `${siteUrl}/dashboard/events`,
    },
    {
      key: "nudge",
      label: "Application nudge",
      subject: "Finish your batch0 application",
      body: "Hi {{name}},\n\nYou started an application but haven't submitted it yet. Seats are limited and reviews are rolling — a few minutes now keeps your spot in the running.\n\n— The batch0 team",
      ctaLabel: "Continue application",
      ctaUrl: `${siteUrl}/apply`,
    },
    {
      // Written with {{student}} rather than {{name}} so the same copy reads
      // correctly whether it lands in a parent's inbox or the student's.
      key: "parent-update",
      label: "Parent update",
      subject: "A quick batch0 update",
      body: "Hi {{name}},\n\nA short update on {{student}} and what's happening at batch0 over the next few weeks.\n\n[Write your update here.]\n\nIf you have any questions, just reply to this email — it reaches us directly.\n\n— The batch0 team",
      ctaLabel: "See the program",
      ctaUrl: `${siteUrl}/program`,
    },
  ];
}

export function BlastForm({
  cohortNames,
  siteUrl,
}: {
  cohortNames: string[];
  siteUrl: string;
}) {
  // ---- recipient selection ----
  const [audience, setAudience] = useState<AudienceKey>("students");
  const [sendTo, setSendTo] = useState<BlastAudience>("students");
  const [cohort, setCohort] = useState<string>("");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Rows for the active audience, fetched from the server when the pill
  // changes — the page doesn't ship the directory. Cohort + search stay
  // client-side filters within the loaded segment, exactly as before.
  const [recipients, setRecipients] = useState<BlastRecipient[]>([]);
  const [loadingRecipients, setLoadingRecipients] = useState(true);
  const [recipientsError, setRecipientsError] = useState<string | null>(null);
  // Every row ever fetched, kept across audience switches so a selection
  // made under one filter still counts (and dedupes) after moving to
  // another — you can pick 3 accepted, flip to waitlisted, add 2 more.
  const loadedById = useRef(new Map<string, BlastRecipient>());

  useEffect(() => {
    let cancelled = false;
    setLoadingRecipients(true);
    setRecipientsError(null);
    setRecipients([]);
    getRecipients(audience).then((res) => {
      if (cancelled) return;
      if (res.ok) {
        for (const r of res.recipients) loadedById.current.set(r.id, r);
        setRecipients(res.recipients);
      } else {
        setRecipientsError(res.error);
      }
      setLoadingRecipients(false);
    });
    return () => {
      cancelled = true;
    };
  }, [audience]);

  /** Everyone matching the filter pills, before the parent-address rule. */
  const matching = useMemo(() => {
    const q = search.trim().toLowerCase();
    return recipients.filter((r) => {
      if (cohort && !r.cohorts.includes(cohort)) return false;
      if (
        q &&
        !(r.name ?? "").toLowerCase().includes(q) &&
        !r.email.toLowerCase().includes(q) &&
        !(r.parentEmail ?? "").toLowerCase().includes(q)
      )
        return false;
      return true;
    });
  }, [recipients, cohort, search]);

  // Parents-only can't reach someone who never gave a parent address, so they
  // drop out of the list — and get counted, because a filter that silently
  // shrinks is how you think you emailed 40 families and actually emailed 12.
  const filtered = useMemo(
    () => (sendTo === "parents" ? matching.filter((r) => r.parentEmail) : matching),
    [matching, sendTo],
  );
  const missingParent = useMemo(
    () => matching.filter((r) => !r.parentEmail).length,
    [matching],
  );

  // Unique addresses the current selection resolves to — mirrors the dedupe
  // in buildEnvelopes() so the button never promises a number the send can't
  // match. Siblings sharing one parent address count once. Reads the loaded
  // cache, not the active segment, because a selection can span audiences.
  const selectedPeople = useMemo(
    () =>
      Array.from(selected)
        .map((id) => loadedById.current.get(id))
        .filter((r): r is BlastRecipient => !!r),
    // recipients is a dep so the memo re-runs once a fetch lands in the cache.
    [selected, recipients],
  );
  const addressCount = useMemo(
    () =>
      buildEnvelopes(
        selectedPeople.map((r) => ({
          email: r.email,
          full_name: r.name,
          parentEmail: r.parentEmail,
        })),
        sendTo,
      ).length,
    [selectedPeople, sendTo],
  );
  const selectedWithoutParent = useMemo(
    () => (sendTo === "students" ? 0 : selectedPeople.filter((r) => !r.parentEmail).length),
    [selectedPeople, sendTo],
  );

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
  // Which copy is on screen. Follows the Send-to choice, but stays
  // independently switchable so you can eyeball both before sending "Both".
  const [variant, setVariant] = useState<BlastVariant>("student");
  useEffect(() => {
    setVariant(sendTo === "parents" ? "parent" : "student");
  }, [sendTo]);

  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  const previewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (previewTimer.current) clearTimeout(previewTimer.current);
    if (!subject.trim() || !body.trim()) {
      setPreviewHtml(null);
      return;
    }
    previewTimer.current = setTimeout(async () => {
      const res = await renderBlastPreview(
        { subject, body, ctaLabel, ctaUrl },
        variant,
      );
      if (res.ok) setPreviewHtml(res.html);
    }, 600);
    return () => {
      if (previewTimer.current) clearTimeout(previewTimer.current);
    };
  }, [subject, body, ctaLabel, ctaUrl, variant]);

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
    // Tests the copy currently on screen, so the parent variant is verifiable
    // end-to-end and not just previewed.
    const res = await sendTestBlast(draft, variant);
    setTestState({ busy: false, message: res.message, ok: res.ok });
  }

  async function onSend() {
    setSending(true);
    setResult(null);
    const res = await sendBlast(Array.from(selected), draft, sendTo);
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
          <span className="rounded-full border border-phosphor/40 bg-phosphor/10 px-2.5 py-0.5 text-xs font-medium tabular-nums text-phosphor-ink">
            {selected.size} selected
          </span>
        </div>

        {/* Which inbox — applies to whichever filter is active below. */}
        <div className="mt-4">
          <p className="mb-1.5 text-[10px] font-mono font-semibold uppercase tracking-[0.18em] text-ink-faint">
            Send to
          </p>
          <div className="flex flex-wrap gap-2">
            {SEND_TO.map((s) => (
              <button
                key={s.key}
                type="button"
                onClick={() => setSendTo(s.key)}
                aria-pressed={sendTo === s.key}
                title={s.hint}
                className={`rounded-full border px-3 py-1 text-xs transition ${
                  sendTo === s.key
                    ? "border-phosphor bg-phosphor/10 text-phosphor-ink"
                    : "border-line text-ink-soft hover:border-ink/30 hover:text-ink"
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>
          <p className="mt-1.5 text-xs text-ink-faint">
            {SEND_TO.find((s) => s.key === sendTo)?.hint}
            {sendTo !== "students" && (
              <>
                {" "}
                Use{" "}
                <code className="rounded bg-wash px-1 font-mono">
                  {"{{student}}"}
                </code>{" "}
                in the body to name the student.
              </>
            )}
          </p>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          {AUDIENCES.map((a) => (
            <button
              key={a.key}
              type="button"
              onClick={() => setAudience(a.key)}
              className={`rounded-full border px-3 py-1 text-xs transition ${
                audience === a.key
                  ? "border-phosphor bg-phosphor/10 text-phosphor-ink"
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
              className="h-10 rounded-md border border-line bg-paper px-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-phosphor/60"
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
            className="inline-flex items-center gap-1 rounded-md border border-line bg-wash px-2.5 py-1 font-medium text-ink-soft hover:border-ink/30 hover:bg-ink/[0.04]"
          >
            <CheckCheck className="h-3.5 w-3.5" />
            Select all {filtered.length} shown
          </button>
          {selected.size > 0 && (
            <button
              type="button"
              onClick={() => setSelected(new Set())}
              className="inline-flex items-center gap-1 rounded-md border border-line bg-wash px-2.5 py-1 font-medium text-ink-soft hover:border-ink/30 hover:bg-ink/[0.04]"
            >
              <X className="h-3.5 w-3.5" />
              Clear
            </button>
          )}
        </div>

        {sendTo === "parents" && missingParent > 0 && (
          <p className="mt-3 rounded-md border border-amber-500/40 bg-amber-500/[0.06] px-3 py-2 text-xs text-amber-700 dark:text-amber-200">
            {missingParent} {missingParent === 1 ? "person" : "people"} in this
            filter {missingParent === 1 ? "has" : "have"} no parent email on
            their application and {missingParent === 1 ? "is" : "are"} hidden.
            The question is optional, so this is normal.
          </p>
        )}

        <ul className="mt-3 max-h-80 divide-y divide-line overflow-y-auto rounded-lg border border-line">
          {loadingRecipients && (
            <li className="p-4 text-sm text-ink-faint">Loading recipients…</li>
          )}
          {!loadingRecipients && recipientsError && (
            <li className="p-4 text-sm text-red-700 dark:text-red-300">
              {recipientsError}
            </li>
          )}
          {!loadingRecipients && !recipientsError && filtered.length === 0 && (
            <li className="p-4 text-sm text-ink-faint">
              {sendTo === "parents"
                ? "Nobody matching this filter has a parent email on file."
                : "No one matches this filter."}
            </li>
          )}
          {filtered.map((r) => (
            <li key={r.id}>
              <label className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-wash">
                <input
                  type="checkbox"
                  checked={selected.has(r.id)}
                  onChange={() => toggle(r.id)}
                  className="h-4 w-4 accent-[#ffbb00]"
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-ink">
                    {r.name || r.email}
                  </span>
                  {/* Show the address that will actually be used, so the row
                      never implies mail is going somewhere it isn't. */}
                  <span className="block truncate text-xs text-ink-faint">
                    {sendTo === "parents" ? (
                      <span className="text-ink-soft">{r.parentEmail}</span>
                    ) : (
                      r.email
                    )}
                    {r.appStatus ? ` · ${r.appStatus}` : ""}
                    {r.cohorts.length > 0 ? ` · ${r.cohorts.join(", ")}` : ""}
                  </span>
                  {sendTo === "both" && (
                    <span className="block truncate text-xs text-ink-faint">
                      {r.parentEmail ? (
                        <>+ parent {r.parentEmail}</>
                      ) : (
                        <span className="text-amber-700 dark:text-amber-300">
                          no parent email on file
                        </span>
                      )}
                    </span>
                  )}
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
                className="rounded-full border border-line px-3 py-1 text-xs text-ink-soft transition hover:border-phosphor/50 hover:text-phosphor-ink"
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
                greets the reader — the student&apos;s first name, or
                &ldquo;there&rdquo; for a parent.{" "}
                <code className="rounded bg-wash px-1 font-mono">
                  {"{{student}}"}
                </code>{" "}
                is always the student, so one message reads correctly to both.
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
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-soft">
              Preview
            </h2>
            <div className="flex items-center gap-2">
              {sendTo === "both" && (
                <div className="flex rounded-md border border-line p-0.5">
                  {(["student", "parent"] as BlastVariant[]).map((v) => (
                    <button
                      key={v}
                      type="button"
                      onClick={() => setVariant(v)}
                      aria-pressed={variant === v}
                      className={`rounded px-2 py-0.5 text-xs capitalize transition ${
                        variant === v
                          ? "bg-phosphor/15 text-phosphor-ink"
                          : "text-ink-faint hover:text-ink"
                      }`}
                    >
                      {v} copy
                    </button>
                  ))}
                </div>
              )}
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
          </div>
          {sendTo !== "students" && (
            <p className="mt-2 text-xs text-ink-faint">
              Showing the{" "}
              <span className="text-ink-soft">
                {variant === "parent" ? "parent" : "student"}
              </span>{" "}
              copy.{" "}
              {variant === "parent" ? (
                <>
                  <code className="rounded bg-wash px-1 font-mono">
                    {"{{name}}"}
                  </code>{" "}
                  becomes “there” — we never collect a parent&apos;s name.
                </>
              ) : (
                <>
                  <code className="rounded bg-wash px-1 font-mono">
                    {"{{name}}"}
                  </code>{" "}
                  becomes the student&apos;s first name.
                </>
              )}
            </p>
          )}
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

          {selectedWithoutParent > 0 && (
            <p className="mb-3 rounded-md border border-amber-500/40 bg-amber-500/[0.06] px-3 py-2 text-xs text-amber-700 dark:text-amber-200">
              {selectedWithoutParent} of the {selected.size} selected{" "}
              {selectedWithoutParent === 1 ? "has" : "have"} no parent email
              {sendTo === "parents"
                ? " and will be skipped."
                : " — those get the student copy only."}
            </p>
          )}

          {!confirming ? (
            <Button
              type="button"
              className="w-full"
              disabled={!composeValid || addressCount === 0 || sending}
              onClick={() => setConfirming(true)}
            >
              <Send className="h-4 w-4" />
              Send to {addressCount} address{addressCount === 1 ? "" : "es"}
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
                  : `Yes — email ${addressCount} ${
                      sendTo === "students"
                        ? addressCount === 1
                          ? "student"
                          : "students"
                        : sendTo === "parents"
                          ? addressCount === 1
                            ? "parent"
                            : "parents"
                          : addressCount === 1
                            ? "address"
                            : "addresses"
                    } now`}
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
            {selected.size} selected → {addressCount} unique address
            {addressCount === 1 ? "" : "es"}
            {sendTo !== "students" &&
              " (a parent with two students here gets one email)"}
            . There&apos;s no undo — send a test first.
          </p>
        </Card>
      </div>
    </div>
  );
}
