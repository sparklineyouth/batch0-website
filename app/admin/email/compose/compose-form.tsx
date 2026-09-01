"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import {
  Send,
  Clock,
  Users,
  AtSign,
  FileText,
  GraduationCap,
  CheckCheck,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/dialog";
import { RichTextEditor } from "@/components/admin/rich-text-editor";
import { getActionError } from "@/lib/action-error";
import { COMMON_VARIABLES, AUDIENCE_SEGMENTS } from "@/lib/email/catalog";
import { parseAddresses, MAX_DIRECT_RECIPIENTS } from "./shared";
import {
  sendCompose,
  sendTestCompose,
  previewCompose,
  countCompose,
  listComposeStudents,
  type ComposeDraft,
  type ComposeStudent,
} from "./actions";

export type ComposeTemplate = { id: string; name: string; enabled: boolean };
export type ComposeCohort = { id: string; name: string };

const EMPTY: ComposeDraft = {
  to: "",
  mode: "addresses",
  segment: "students",
  cohortId: "",
  includeParents: false,
  studentIds: [],
  templateId: "",
  subject: "",
  bodyHtml: "<p>Hi {{first_name}},</p><p></p>",
  ctaLabel: "",
  ctaUrl: "",
  scheduledFor: "",
};

/**
 * One-off send.
 *
 * The two modes cover the two things people actually come here to do: mail
 * one person who may not have an account at all (a parent, a sponsor, a
 * school), and mail a segment without building a whole automation for a
 * message that goes out once.
 */
export function ComposeForm({
  templates,
  cohorts,
}: {
  templates: ComposeTemplate[];
  cohorts: ComposeCohort[];
}) {
  const [v, setV] = useState<ComposeDraft>(EMPTY);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [failures, setFailures] = useState<{ to: string; reason: string }[]>([]);
  const [confirmSend, setConfirmSend] = useState(false);
  const [previewHtml, setPreviewHtml] = useState("");
  const [segmentCount, setSegmentCount] = useState<number | null>(null);

  // "Pick students" mode: the directory, fetched once the first time the mode
  // is opened (the page doesn't ship it), plus a local search box. Selection
  // itself lives in the draft as `studentIds`, so preview/count read it too.
  const [students, setStudents] = useState<ComposeStudent[]>([]);
  const [loadingStudents, setLoadingStudents] = useState(false);
  const [studentsError, setStudentsError] = useState<string | null>(null);
  const [studentSearch, setStudentSearch] = useState("");

  function set<K extends keyof ComposeDraft>(k: K, val: ComposeDraft[K]) {
    setV((p) => ({ ...p, [k]: val }));
    setNotice(undefined);
    setError(undefined);
  }

  const selectedStudents = useMemo(
    () => new Set(v.studentIds),
    [v.studentIds],
  );

  function toggleStudent(id: string) {
    setNotice(undefined);
    setError(undefined);
    setV((p) => ({
      ...p,
      studentIds: p.studentIds.includes(id)
        ? p.studentIds.filter((x) => x !== id)
        : [...p.studentIds, id],
    }));
  }

  useEffect(() => {
    if (v.mode !== "students" || students.length > 0 || loadingStudents) return;
    let cancelled = false;
    setLoadingStudents(true);
    setStudentsError(null);
    listComposeStudents().then((res) => {
      if (cancelled) return;
      if (res.ok) setStudents(res.students);
      else setStudentsError(res.error);
      setLoadingStudents(false);
    });
    return () => {
      cancelled = true;
    };
  }, [v.mode]);

  const filteredStudents = useMemo(() => {
    const q = studentSearch.trim().toLowerCase();
    if (!q) return students;
    return students.filter(
      (s) =>
        (s.name ?? "").toLowerCase().includes(q) ||
        s.email.toLowerCase().includes(q),
    );
  }, [students, studentSearch]);

  // Recipient count, computed the same way the server will. The addresses
  // case is local (it's just parsing); the segment case has to ask the server,
  // since it's a database question.
  const parsed = useMemo(() => parseAddresses(v.to), [v.to]);
  useEffect(() => {
    if (v.mode !== "segment") return;
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const res = await countCompose(v);
        if (!cancelled) setSegmentCount(res.ok ? res.count : null);
      } catch {
        /* advisory */
      }
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [v.mode, v.segment, v.cohortId, v.includeParents]);

  const recipientCount =
    v.mode === "addresses"
      ? parsed.valid.length
      : v.mode === "students"
        ? v.studentIds.length
        : (segmentCount ?? 0);

  const draftRef = useRef(v);
  draftRef.current = v;
  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const res = await previewCompose(draftRef.current);
        if (!cancelled && res.ok) setPreviewHtml(res.html);
      } catch {
        /* preview is best-effort */
      }
    }, 450);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [v.subject, v.bodyHtml, v.ctaLabel, v.ctaUrl, v.templateId]);

  const usingTemplate = Boolean(v.templateId);

  function onSend() {
    setConfirmSend(false);
    setError(undefined);
    setNotice(undefined);
    setFailures([]);
    start(async () => {
      try {
        // `datetime-local` yields "2026-09-01T10:00" with no zone. Parsed on
        // the server that's 10:00 UTC, not 10:00 where the admin is sitting —
        // so it's resolved to a real instant here, in the browser, where the
        // intended timezone is the one actually available.
        const res = await sendCompose({
          ...v,
          scheduledFor: v.scheduledFor
            ? new Date(v.scheduledFor).toISOString()
            : "",
        });
        if (!res.ok) {
          setError(res.error);
          return;
        }
        setNotice(res.message);
        setFailures(res.failed);
        // Clear the recipients but keep the copy — the usual next action is
        // "same message, different person", not "start over".
        setV((p) => ({ ...p, to: "", studentIds: [], scheduledFor: "" }));
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
        const res = await sendTestCompose(v);
        if (res.ok) setNotice(res.message);
        else setError(res.message);
      } catch (err) {
        setError(getActionError(err));
      }
    });
  }

  return (
    <div className="mx-auto max-w-[1400px]">
      <div>
        <h1 className="font-display text-3xl font-bold tracking-[-0.02em] text-ink">
          Compose
        </h1>
        <p className="mt-1 max-w-2xl text-sm text-ink-soft">
          Send a one-off email — to any address, whether or not they have an
          account, or to a whole audience. Everything goes out in the house
          template and lands in the outbox and the metrics like any other send.
        </p>
      </div>

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
      {failures.length > 0 && (
        <Card className="mt-4 border-amber-500/30 bg-amber-500/5">
          <p className="text-sm font-medium text-ink">
            {failures.length} address{failures.length === 1 ? "" : "es"} didn't go
            through:
          </p>
          <ul className="mt-2 space-y-1 text-xs text-ink-soft">
            {failures.map((f) => (
              <li key={f.to}>
                <span className="font-mono">{f.to}</span> — {f.reason}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_460px]">
        <div className="space-y-5">
          {/* ---- To ---- */}
          <Card className="space-y-4">
            <div className="flex gap-2">
              <ModeChoice
                icon={AtSign}
                label="Specific addresses"
                active={v.mode === "addresses"}
                onClick={() => set("mode", "addresses")}
              />
              <ModeChoice
                icon={GraduationCap}
                label="Pick students"
                active={v.mode === "students"}
                onClick={() => set("mode", "students")}
              />
              <ModeChoice
                icon={Users}
                label="An audience"
                active={v.mode === "segment"}
                onClick={() => set("mode", "segment")}
              />
            </div>

            {v.mode === "addresses" ? (
              <div>
                <Label htmlFor="compose-to">To</Label>
                <Textarea
                  id="compose-to"
                  value={v.to}
                  onChange={(e) => set("to", e.target.value)}
                  rows={3}
                  placeholder={"parent@example.com, Jane Doe <jane@school.org>\nor one per line"}
                />
                <p className="mt-1 text-xs text-ink-faint">
                  Commas, semicolons, or new lines. Up to{" "}
                  {MAX_DIRECT_RECIPIENTS} at a time.{" "}
                  {parsed.valid.length > 0 && (
                    <span className="text-emerald-600 dark:text-emerald-400">
                      {parsed.valid.length} valid
                    </span>
                  )}
                  {parsed.invalid.length > 0 && (
                    <span className="ml-2 text-red-500">
                      {parsed.invalid.length} not a valid address
                    </span>
                  )}
                </p>
              </div>
            ) : v.mode === "students" ? (
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <Input
                    value={studentSearch}
                    onChange={(e) => setStudentSearch(e.target.value)}
                    placeholder="Search name or email…"
                    aria-label="Search students"
                  />
                  <span className="shrink-0 rounded-full border border-phosphor/40 bg-phosphor/10 px-2.5 py-0.5 text-xs font-medium tabular-nums text-phosphor-ink">
                    {v.studentIds.length} selected
                  </span>
                </div>

                <div className="flex items-center gap-2 text-xs">
                  <button
                    type="button"
                    onClick={() =>
                      setV((p) => ({
                        ...p,
                        studentIds: Array.from(
                          new Set([
                            ...p.studentIds,
                            ...filteredStudents.map((s) => s.id),
                          ]),
                        ),
                      }))
                    }
                    disabled={filteredStudents.length === 0}
                    className="inline-flex items-center gap-1 rounded-md border border-line bg-wash px-2.5 py-1 font-medium text-ink-soft hover:border-ink/30 hover:bg-ink/[0.04] disabled:opacity-50"
                  >
                    <CheckCheck className="h-3.5 w-3.5" />
                    Select all {filteredStudents.length} shown
                  </button>
                  {v.studentIds.length > 0 && (
                    <button
                      type="button"
                      onClick={() => set("studentIds", [])}
                      className="inline-flex items-center gap-1 rounded-md border border-line bg-wash px-2.5 py-1 font-medium text-ink-soft hover:border-ink/30 hover:bg-ink/[0.04]"
                    >
                      <X className="h-3.5 w-3.5" />
                      Clear
                    </button>
                  )}
                </div>

                <ul className="max-h-80 divide-y divide-line overflow-y-auto rounded-lg border border-line">
                  {loadingStudents && (
                    <li className="p-4 text-sm text-ink-faint">Loading students…</li>
                  )}
                  {!loadingStudents && studentsError && (
                    <li className="p-4 text-sm text-red-700 dark:text-red-300">
                      {studentsError}
                    </li>
                  )}
                  {!loadingStudents &&
                    !studentsError &&
                    filteredStudents.length === 0 && (
                      <li className="p-4 text-sm text-ink-faint">
                        {students.length === 0
                          ? "No students with an email on file."
                          : "No students match that search."}
                      </li>
                    )}
                  {filteredStudents.map((s) => (
                    <li key={s.id}>
                      <label className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-wash">
                        <input
                          type="checkbox"
                          checked={selectedStudents.has(s.id)}
                          onChange={() => toggleStudent(s.id)}
                          className="h-4 w-4 accent-phosphor"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm text-ink">
                            {s.name || s.email}
                          </span>
                          <span className="block truncate text-xs text-ink-faint">
                            {s.email}
                            {s.appStatus ? ` · ${s.appStatus}` : ""}
                            {s.cohorts.length > 0
                              ? ` · ${s.cohorts.join(", ")}`
                              : ""}
                          </span>
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <Label htmlFor="compose-segment">Audience</Label>
                    <Select
                      id="compose-segment"
                      value={v.segment}
                      onChange={(e) => set("segment", e.target.value)}
                    >
                      {AUDIENCE_SEGMENTS.map((s) => (
                        <option key={s.value} value={s.value}>
                          {s.label}
                        </option>
                      ))}
                    </Select>
                  </div>
                  <div>
                    <Label htmlFor="compose-cohort">Cohort (optional)</Label>
                    <Select
                      id="compose-cohort"
                      value={v.cohortId}
                      onChange={(e) => set("cohortId", e.target.value)}
                    >
                      <option value="">Any cohort</option>
                      {cohorts.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </Select>
                  </div>
                </div>
                <label className="flex items-center gap-2 text-sm text-ink-soft">
                  <input
                    type="checkbox"
                    checked={v.includeParents}
                    onChange={(e) => set("includeParents", e.target.checked)}
                    className="h-4 w-4 accent-phosphor"
                  />
                  Also send to parent addresses on file
                </label>
                <div className="rounded-lg border border-line bg-wash px-3 py-2 text-sm text-ink-soft">
                  {segmentCount === null
                    ? "Counting…"
                    : `${segmentCount} address${segmentCount === 1 ? "" : "es"}`}
                </div>
              </div>
            )}
          </Card>

          {/* ---- Message ---- */}
          <Card className="space-y-4">
            <div>
              <Label htmlFor="compose-template">Start from a template</Label>
              <Select
                id="compose-template"
                value={v.templateId}
                onChange={(e) => set("templateId", e.target.value)}
              >
                <option value="">Write a one-off message</option>
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                    {t.enabled ? "" : " (disabled)"}
                  </option>
                ))}
              </Select>
              {usingTemplate && (
                <p className="mt-1.5 flex items-center gap-1.5 text-xs text-ink-soft">
                  <FileText className="h-3.5 w-3.5" />
                  Sending the saved template as-is, personalized per recipient.{" "}
                  <Link
                    href={`/admin/email/templates/${v.templateId}`}
                    className="text-phosphor-ink underline"
                  >
                    Edit it
                  </Link>
                </p>
              )}
            </div>

            {!usingTemplate && (
              <>
                <div>
                  <Label htmlFor="compose-subject">Subject</Label>
                  <Input
                    id="compose-subject"
                    value={v.subject}
                    onChange={(e) => set("subject", e.target.value)}
                    placeholder="A quick note about Demo Day"
                  />
                </div>
                <div>
                  <Label>Message</Label>
                  <RichTextEditor
                    value={v.bodyHtml}
                    onChange={(html) => set("bodyHtml", html)}
                    variables={COMMON_VARIABLES}
                    minHeight={240}
                  />
                  <p className="mt-1 text-xs text-ink-faint">
                    {`{{first_name}}`} fills in for anyone with an account. For an
                    address we don't know, it falls back to “there”.
                  </p>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <Label htmlFor="compose-cta-label">Button label</Label>
                    <Input
                      id="compose-cta-label"
                      value={v.ctaLabel}
                      onChange={(e) => set("ctaLabel", e.target.value)}
                      placeholder="optional"
                    />
                  </div>
                  <div>
                    <Label htmlFor="compose-cta-url">Button URL</Label>
                    <Input
                      id="compose-cta-url"
                      value={v.ctaUrl}
                      onChange={(e) => set("ctaUrl", e.target.value)}
                      placeholder="https://batch0.org/…"
                      className="font-mono text-xs"
                    />
                  </div>
                </div>
              </>
            )}
          </Card>

          {/* ---- When ---- */}
          <Card className="space-y-3">
            <Label htmlFor="compose-when">Send</Label>
            <div className="flex flex-wrap items-center gap-3">
              <Select
                id="compose-when"
                value={v.scheduledFor ? "later" : "now"}
                onChange={(e) =>
                  set(
                    "scheduledFor",
                    e.target.value === "now" ? "" : defaultScheduleValue(),
                  )
                }
                className="max-w-[200px]"
              >
                <option value="now">Right now</option>
                <option value="later">At a specific time</option>
              </Select>
              {v.scheduledFor && (
                <Input
                  type="datetime-local"
                  value={v.scheduledFor}
                  onChange={(e) => set("scheduledFor", e.target.value)}
                  className="max-w-[240px]"
                  aria-label="Send at"
                />
              )}
            </div>
            {v.scheduledFor && (
              <p className="flex items-center gap-1.5 text-xs text-ink-soft">
                <Clock className="h-3.5 w-3.5" />
                In your local time. It goes into the outbox and sends on the
                first queue run after that moment — you can cancel it until then.
              </p>
            )}
          </Card>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              onClick={() => setConfirmSend(true)}
              disabled={pending || recipientCount === 0}
            >
              <Send className="h-4 w-4" />
              {v.scheduledFor ? "Schedule" : "Send"}
              {recipientCount > 0 && ` to ${recipientCount}`}
            </Button>
            <Button variant="secondary" onClick={onTest} disabled={pending}>
              Send me a test
            </Button>
          </div>
        </div>

        {/* ---- Preview ---- */}
        <div className="lg:sticky lg:top-6 lg:self-start">
          <Card className="!p-0 overflow-hidden">
            <div className="border-b border-line px-4 py-2.5 text-xs font-semibold uppercase tracking-wider text-ink-faint">
              Preview
            </div>
            <div className="bg-[#0a0a0a] p-2">
              <iframe
                title="Email preview"
                srcDoc={previewHtml}
                sandbox=""
                className="h-[620px] w-full rounded-lg border-0 bg-[#0a0a0a]"
              />
            </div>
          </Card>
        </div>
      </div>

      <ConfirmDialog
        open={confirmSend}
        onCancel={() => setConfirmSend(false)}
        onConfirm={onSend}
        title={v.scheduledFor ? "Schedule this email?" : "Send this email?"}
        description={
          v.mode === "addresses"
            ? `Going to ${parsed.valid.length} address${parsed.valid.length === 1 ? "" : "es"}: ${parsed.valid.slice(0, 5).join(", ")}${parsed.valid.length > 5 ? `, and ${parsed.valid.length - 5} more` : ""}.`
            : v.mode === "students"
              ? `Going to ${v.studentIds.length} hand-picked student${v.studentIds.length === 1 ? "" : "s"}, personalized by name.`
              : `Going to every address in "${
                  AUDIENCE_SEGMENTS.find((s) => s.value === v.segment)?.label ?? v.segment
                }" — ${segmentCount ?? "…"} right now.`
        }
        confirmLabel={v.scheduledFor ? "Schedule it" : "Send it"}
        pending={pending}
      />
    </div>
  );
}

/** An hour from now, formatted for `datetime-local` in the browser's zone. */
function defaultScheduleValue(): string {
  const d = new Date(Date.now() + 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

function ModeChoice({
  icon: Icon,
  label,
  active,
  onClick,
}: {
  icon: typeof AtSign;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`inline-flex flex-1 items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition-none active:scale-[0.99] ${
        active
          ? "border-phosphor bg-phosphor/10 text-ink"
          : "border-line bg-paper text-ink-soft hover:border-ink/30 hover:bg-wash"
      }`}
    >
      <Icon className="h-4 w-4" />
      {label}
    </button>
  );
}
