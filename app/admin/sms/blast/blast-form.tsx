"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  Clock,
  FlaskConical,
  Inbox,
  MessageSquare,
  Send,
  ShieldCheck,
  Users,
  Wand2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { ConfirmDialog } from "@/components/ui/dialog";
import { getActionError } from "@/lib/action-error";
import { PHONE_MAX_LENGTH, isValidPhone } from "@/lib/phone";
import { GSM_SUBSTITUTIONS, measureSms, toGsmSafe } from "@/lib/sms/segments";
import { carriesFirstMessageDisclosure, withFirstMessageDisclosure } from "@/lib/sms/copy";
import type { SmsAudienceSegment } from "@/lib/sms/policy";
import {
  describeRecipients,
  describeUnreachable,
  estimateCost,
  formatCost,
  formatQuietWindow,
} from "./shared";
import {
  previewSmsAudience,
  sendSmsCampaign,
  sendTestSms,
  type CampaignResult,
  type SmsAudiencePreview,
  type TestSendOutcome,
} from "./actions";

/**
 * The SMS campaign composer.
 *
 * Structurally the email blast's twin, with one lane: a program text to the
 * students' own numbers. There is no purpose switch because there is nothing to
 * switch to — lib/sms/policy.ts keeps promotional texts off, and the page says
 * what belongs here instead, because "is this a program update or is it
 * selling something?" is the question an operator has to ask of every message.
 *
 * Everything expensive is counted before it is spent: segments live as you type
 * (SMS bills per 160 characters, or per 70 the moment one emoji appears), the
 * reachable count and its cost come from the same resolver the send uses, and a
 * real test text to a real phone is required before the send button exists.
 */

export type BlastSegmentOption = { value: SmsAudienceSegment; label: string };
export type BlastCohort = { id: string; name: string };

/** Keys of the unreachable map, without importing the server module that owns them. */
type UnreachableKey = keyof SmsAudiencePreview["counts"];

/**
 * A stable id for one draft.
 *
 * It is what makes `campaign:<id>:<phone>` collapse a double submit: the server
 * looks a campaign up by this key before inserting, so two clicks land on one
 * campaign id and the unique index on sms_outbox.dedupe_key rejects the second
 * set of rows. A fresh uuid per submit would defeat the whole mechanism.
 */
function newDraftKey(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  // Only reached in an environment without WebCrypto — and during SSR, where the
  // value is thrown away on hydration.
  return `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

export function BlastForm({
  segments,
  cohorts,
  maxSegments,
  fromNumber,
  helpText,
  transportDetail,
  adminTestConsent: ADMIN_TEST_CONSENT,
}: {
  segments: readonly BlastSegmentOption[];
  cohorts: BlastCohort[];
  /**
   * MAX_SEGMENTS, passed down rather than imported: it lives in lib/sms/send.ts
   * next to the transport that enforces it, and that module pulls in the Supabase
   * admin client — which must never reach a client bundle.
   */
  maxSegments: number;
  fromNumber: string;
  helpText: string;
  transportDetail: string;
  /**
   * CONSENT_COPY.adminTest, handed down for the same reason maxSegments is:
   * lib/sms/consent.ts pulls in the service-role client.
   */
  adminTestConsent: string;
}) {
  // ---- what it says -------------------------------------------------------
  const [name, setName] = useState("");
  const [body, setBody] = useState("");

  // ---- who gets it --------------------------------------------------------
  const [segment, setSegment] = useState<SmsAudienceSegment>(
    segments[0]?.value ?? "enrolled",
  );
  const [cohortId, setCohortId] = useState("");

  // ---- when ---------------------------------------------------------------
  const [sendAt, setSendAt] = useState("");

  const [draftKey, setDraftKey] = useState(newDraftKey);

  // A new key whenever the draft's CONTENT changes. Re-submitting the same copy
  // then collapses into the existing campaign's parked rows, while an edited
  // message becomes a genuinely new campaign instead of a no-op against the old
  // one's dedupe keys.
  useEffect(() => {
    setDraftKey(newDraftKey());
  }, [body, segment, cohortId]);

  // ---- the resolved audience ---------------------------------------------
  const [preview, setPreview] = useState<SmsAudiencePreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [counting, setCounting] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setCounting(true);
    setPreviewError(null);
    const t = setTimeout(async () => {
      try {
        const res = await previewSmsAudience({ segment, cohortId });
        if (cancelled) return;
        if (res.ok) setPreview(res.preview);
        else {
          setPreview(null);
          setPreviewError(res.error);
        }
      } catch (err) {
        if (!cancelled) {
          setPreview(null);
          setPreviewError(getActionError(err));
        }
      } finally {
        if (!cancelled) setCounting(false);
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [segment, cohortId]);

  // ---- segment arithmetic, live ------------------------------------------
  const measured = useMemo(() => measureSms(body), [body]);
  const overCeiling = measured.segments > maxSegments;
  const headroom = measured.capacity * measured.segments - measured.units;

  // Which offending characters have an ASCII twin and which don't. The
  // distinction is the whole difference between "click to fix" and "delete the
  // emoji" — toGsmSafe only rewrites typography, and pretending otherwise would
  // leave someone clicking a button that changes nothing.
  const substitutable = useMemo(
    () => new Set(GSM_SUBSTITUTIONS.map(([from]) => from)),
    [],
  );
  const fixable = measured.nonGsmChars.filter((c) => substitutable.has(c));
  const unfixable = measured.nonGsmChars.filter((c) => !substitutable.has(c));
  const afterFix = useMemo(
    () => (fixable.length > 0 ? measureSms(toGsmSafe(body)) : null),
    // fixable is derived from body, so body alone is the real dependency.
    [body, fixable.length],
  );
  // Only claim a saving when there is one. Rewriting a curly quote inside a
  // message that also carries an emoji changes nothing about the price, and a
  // "this will be cheaper" line that isn't true costs more trust than it saves.
  const savedSegments = afterFix ? measured.segments - afterFix.segments : 0;

  // The transport appends the CTIA disclosure to the FIRST text a number ever
  // receives, unless the message already names the brand, STOP and the rates
  // notice itself — the same function decides both (lib/sms/copy.ts). It can
  // push a message over a segment boundary, so the composer shows that rather
  // than letting the invoice do it.
  const disclosureApplies =
    body.trim().length > 0 && !carriesFirstMessageDisclosure(body, helpText);
  const firstTimeSegments = useMemo(
    () =>
      disclosureApplies
        ? measureSms(withFirstMessageDisclosure(body, helpText, true)).segments
        : measured.segments,
    [body, helpText, disclosureApplies, measured.segments],
  );

  const reachable = preview?.reachable ?? 0;
  const cost = estimateCost(measured.segments, reachable);

  // ---- send state ---------------------------------------------------------
  const [pending, start] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string>();
  const [result, setResult] = useState<CampaignResult | null>(null);

  // ---- the required test send --------------------------------------------
  const [testPhone, setTestPhone] = useState("");
  // Unchecked by default, like every consent box in this feature: ticking it
  // writes a ledger row in the admin's name.
  const [ownNumber, setOwnNumber] = useState(false);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<{
    outcome: TestSendOutcome;
    /** The copy the test actually proved. */
    body: string;
  } | null>(null);

  // A test proves ONE message. Edit the copy afterwards and it proves nothing,
  // which is the failure this gate exists to catch — the typo goes in after the
  // test, not before it.
  const tested =
    test !== null &&
    test.outcome.ran &&
    test.outcome.chainProven &&
    test.body === body.trim();

  async function onTest() {
    setTesting(true);
    setError(undefined);
    try {
      const outcome = await sendTestSms(testPhone, body, ownNumber);
      setTest({ outcome, body: body.trim() });
    } catch (err) {
      setError(getActionError(err));
    } finally {
      setTesting(false);
    }
  }

  // ---- send ---------------------------------------------------------------
  const blockers: string[] = [];
  if (!name.trim()) blockers.push("Name the campaign.");
  if (!body.trim()) blockers.push("Write the message.");
  if (overCeiling) {
    blockers.push(`Get it under ${maxSegments} segments (it's ${measured.segments}).`);
  }
  if (reachable === 0) {
    blockers.push("Nobody in this audience can be texted yet.");
  }
  if (!tested) {
    if (!test) {
      blockers.push("Send a test to one real phone first.");
    } else if (!test.outcome.ran) {
      blockers.push("That test never went out — fix the number and try again.");
    } else if (!test.outcome.chainProven) {
      blockers.push("The test didn't go out, so nothing about the campaign is proven yet.");
    } else {
      blockers.push("The message changed after the test. Send another.");
    }
  }
  const ready = blockers.length === 0;

  function onSend() {
    setConfirming(false);
    setError(undefined);
    setResult(null);
    start(async () => {
      try {
        const res = await sendSmsCampaign({
          name,
          body,
          segment,
          cohortId: cohortId || null,
          // `datetime-local` has no zone: "2026-09-27T09:00" parsed on the
          // server is 09:00 UTC, not 09:00 where the admin is sitting. Resolved
          // to a real instant here, in the only place the intended zone exists.
          sendAt: sendAt ? new Date(sendAt).toISOString() : "",
          clientKey: draftKey,
        });
        setResult(res);
        // Clear the proof, not the copy. Another send needs another test — which
        // is the second half of the double-spend guard, the first being that the
        // draft key stays put until the message changes.
        if (res.ok) setTest(null);
      } catch (err) {
        setError(getActionError(err));
      }
    });
  }

  return (
    <div className="mt-8">
      {error && (
        <div className="mb-5 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-700 dark:text-red-300">
          {error}
        </div>
      )}
      {result && !result.ok && (
        <div className="mb-5 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-700 dark:text-red-300">
          {result.error}
        </div>
      )}
      {result && result.ok && (
        <div className="mb-5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-700 dark:text-emerald-300">
          <p>
            Queued {result.queued} text{result.queued === 1 ? "" : "s"} as “
            {result.name}” — {result.segmentsPerMessage} segment
            {result.segmentsPerMessage === 1 ? "" : "s"} each. They go out on the
            next queue run, spaced to keep the toll-free number under its
            carrier limit.
          </p>
          {result.duplicate > 0 && (
            <p className="mt-1">
              {result.duplicate} of them were already queued under this draft and
              were not queued twice — that&apos;s the dedupe key working.
            </p>
          )}
          {result.failed > 0 && (
            <p className="mt-1 text-red-700 dark:text-red-300">
              {result.failed} couldn&apos;t be queued
              {result.errors.length > 0 ? `: ${result.errors.join("; ")}` : "."}
            </p>
          )}
          <p className="mt-2 flex flex-wrap items-center gap-3">
            <Link
              href={`/admin/sms/outbox?campaign=${result.campaignId}`}
              className="inline-flex items-center gap-1.5 underline"
            >
              <Inbox className="h-3.5 w-3.5" />
              Watch it drain
            </Link>
            <button
              type="button"
              onClick={() => {
                setDraftKey(newDraftKey());
                setResult(null);
              }}
              className="underline"
            >
              Start a new draft with this copy
            </button>
          </p>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,440px)_minmax(0,1fr)]">
        {/* ---------------- who gets it ---------------- */}
        <div className="space-y-6 lg:sticky lg:top-6 lg:self-start">
          <Card>
            <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-ink-soft">
              <Users className="h-4 w-4" /> Who gets this
            </h2>

            {/* What belongs in this lane, said every time. Program texts are
                the only kind there is, so the line an operator has to hold is
                "is this a program update, or is it selling something?" */}
            <div className="mt-4 rounded-lg border border-line bg-paper px-3 py-2.5 text-xs leading-relaxed">
              <p className="text-ink">
                Goes to each student&apos;s <strong className="font-semibold">own
                number</strong>, and only if they turned texts on.
              </p>
              <p className="mt-1 text-ink-soft">
                Program updates only — a session starting, a room or time change,
                a deadline, a schedule slip.
              </p>
              <p className="mt-1.5 flex gap-1.5 text-ink-faint">
                <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>
                  No promotions, offers, or &ldquo;tell a friend&rdquo; — a
                  program text with a pitch stapled to it is a marketing text,
                  and our privacy policy promises we don&apos;t send those.
                </span>
              </p>
            </div>

            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <div>
                <Label htmlFor="sms-segment">Audience</Label>
                <Select
                  id="sms-segment"
                  value={segment}
                  onChange={(e) => setSegment(e.target.value as SmsAudienceSegment)}
                >
                  {segments.map((s) => (
                    <option key={s.value} value={s.value}>
                      {s.label}
                    </option>
                  ))}
                </Select>
              </div>
              <div>
                <Label htmlFor="sms-cohort">Cohort (optional)</Label>
                <Select
                  id="sms-cohort"
                  value={cohortId}
                  onChange={(e) => setCohortId(e.target.value)}
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

            {/* ---- reachability + price ---- */}
            <div
              aria-live="polite"
              className="mt-4 rounded-lg border border-line bg-paper p-4"
            >
              {previewError ? (
                <p className="text-sm text-red-700 dark:text-red-300">
                  {previewError}
                </p>
              ) : counting && !preview ? (
                <p className="text-sm text-ink-faint">Counting…</p>
              ) : preview ? (
                <>
                  <div className="flex items-end justify-between gap-3">
                    <div>
                      <p className="font-display text-3xl font-bold tracking-[-0.02em] tabular-nums text-ink">
                        {preview.reachable}
                      </p>
                      <p className="text-xs text-ink-faint">
                        student{preview.reachable === 1 ? "" : "s"} we can text
                        {counting ? " · updating…" : ""}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="font-mono text-lg tabular-nums text-ink">
                        {formatCost(cost)}
                      </p>
                      <p className="text-xs text-ink-faint">
                        {measured.segments} seg × {preview.reachable}, estimated
                      </p>
                    </div>
                  </div>

                  {/* The headline number. A composer that reports only the
                      reachable count hides the one that's wrong. */}
                  {(() => {
                    const line = describeUnreachable(
                      preview.reachable,
                      preview.counts,
                      preview.labels,
                    );
                    if (!line) return null;
                    const rows = (
                      Object.entries(preview.counts) as [UnreachableKey, number][]
                    )
                      .filter(([, n]) => n > 0)
                      .sort((a, b) => b[1] - a[1]);
                    return (
                      <div className="mt-3 rounded-md border border-amber-500/40 bg-amber-500/[0.06] px-3 py-2">
                        <p className="text-xs text-amber-700 dark:text-amber-200">
                          {line}
                        </p>
                        <ul className="mt-1.5 space-y-0.5 text-xs text-ink-soft">
                          {rows.map(([reason, n]) => (
                            <li
                              key={reason}
                              className="flex items-baseline justify-between gap-3"
                            >
                              <span>{preview.labels[reason]}</span>
                              <span className="font-mono tabular-nums">{n}</span>
                            </li>
                          ))}
                        </ul>
                        <p className="mt-1.5 text-xs text-ink-faint">
                          Consent and numbers are collected at{" "}
                          <Link
                            href="/admin/sms/collect"
                            className="underline hover:text-ink-soft"
                          >
                            Collect numbers
                          </Link>
                          .
                        </p>
                      </div>
                    );
                  })()}

                  {preview.truncated && (
                    <p className="mt-2 text-xs text-amber-700 dark:text-amber-200">
                      This audience hit the per-send ceiling and was truncated.
                      Narrow it by cohort and send in parts.
                    </p>
                  )}

                  {/* Nobody reachable AND nobody blocked means the segment itself
                      is empty — a different problem from a consent gap, and one
                      the unreachable breakdown above says nothing about. */}
                  {preview.reachable === 0 &&
                    Object.values(preview.counts).every((n) => n === 0) && (
                      <p className="mt-2 text-xs text-ink-soft">
                        Nobody is in this audience at all
                        {cohortId ? " for that cohort" : ""} — try a wider one.
                      </p>
                    )}

                  {/* Quiet hours defer, never drop — so say when, not whether. */}
                  <p className="mt-3 flex gap-1.5 text-xs text-ink-faint">
                    <Clock className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>
                      Quiet hours{" "}
                      {formatQuietWindow(
                        preview.quiet.startHour,
                        preview.quiet.endHour,
                      )}{" "}
                      in each recipient&apos;s own time zone.{" "}
                      {preview.quiet.deferred === 0 ? (
                        <>
                          Everyone here is inside their window right now, so the
                          next queue run sends the lot.
                        </>
                      ) : (
                        <>
                          {preview.quiet.deferred} of {preview.reachable} are
                          outside theirs — those queue instead of dropping
                          {preview.quiet.firstSendLabel
                            ? `, and start going out ${preview.quiet.firstSendLabel}`
                            : ""}
                          .
                        </>
                      )}
                    </span>
                  </p>
                </>
              ) : null}
            </div>

            <p className="mt-3 text-xs text-ink-faint">{transportDetail}</p>
          </Card>
        </div>

        {/* ---------------- the message ---------------- */}
        <div className="space-y-6">
          <Card className="space-y-4">
            <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-ink-soft">
              <MessageSquare className="h-4 w-4" /> Message
            </h2>

            <div>
              <Label htmlFor="sms-name" required>
                Campaign name
              </Label>
              <Input
                id="sms-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Kickoff reminder — March cohort"
              />
              <p className="mt-1 text-xs text-ink-faint">
                Internal label for the outbox and the audit log. Never sent to
                anyone.
              </p>
            </div>

            <div>
              <Label htmlFor="sms-body" required>
                Text
              </Label>
              <Textarea
                id="sms-body"
                rows={6}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                error={overCeiling}
                placeholder="batch0: your session starts at 6pm tonight. Join from the dashboard - see you there."
                className="font-mono text-sm"
              />

              {/* Live cost, in the units a carrier bills in. */}
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-xs">
                <span
                  className={`rounded px-1.5 py-0.5 ${
                    measured.encoding === "GSM-7"
                      ? "bg-wash text-ink-soft"
                      : "bg-amber-500/15 text-amber-700 dark:text-amber-200"
                  }`}
                >
                  {measured.encoding}
                </span>
                <span
                  className={
                    overCeiling
                      ? "font-semibold text-red-700 dark:text-red-300"
                      : "text-ink-soft"
                  }
                >
                  {measured.segments} segment{measured.segments === 1 ? "" : "s"}
                </span>
                <span className="tabular-nums text-ink-faint">
                  {measured.units} / {measured.capacity * measured.segments}{" "}
                  characters
                </span>
                {body.length > 0 && (
                  <span className="tabular-nums text-ink-faint">
                    {headroom} before segment {measured.segments + 1}
                  </span>
                )}
              </div>

              {/* The id is what Textarea's error prop points aria-describedby at
                  — without it the invalid state announces nothing. */}
              {overCeiling && (
                <div
                  id="sms-body-error"
                  role="alert"
                  className="mt-2 rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-700 dark:text-red-300"
                >
                  {measured.segments} segments is over the {maxSegments}-segment
                  ceiling, so the transport will refuse it. A text this long
                  doesn&apos;t get read — at this length it is nearly always a
                  paste out of a document, which is exactly the send the ceiling
                  exists to stop.
                </div>
              )}

              {measured.nonGsmChars.length > 0 && (
                <div className="mt-2 rounded-md border border-amber-500/40 bg-amber-500/[0.06] px-3 py-2 text-xs">
                  <p className="flex gap-1.5 text-amber-700 dark:text-amber-200">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>
                      {measured.nonGsmChars.length} character
                      {measured.nonGsmChars.length === 1 ? "" : "s"} outside
                      GSM-7 forced this message to UCS-2:{" "}
                      {measured.nonGsmChars.map((c, i) => (
                        <code
                          key={`${c}-${i}`}
                          className="mx-0.5 rounded bg-wash px-1 font-mono"
                        >
                          {c}
                        </code>
                      ))}
                    </span>
                  </p>
                  <p className="mt-1.5 text-ink-soft">
                    On UCS-2 a segment holds 70 characters instead of 160 — one
                    curly quote or one emoji is enough to do it. This message
                    costs {measured.segments} segment
                    {measured.segments === 1 ? "" : "s"} per recipient
                    {reachable > 0 ? `, ${formatCost(cost)} across ${reachable}` : ""}
                    {savedSegments > 0 ? (
                      <>
                        {" "}
                        — cleaning it up drops that to {afterFix?.segments}{" "}
                        {afterFix?.segments === 1 ? "segment" : "segments"}
                        {reachable > 0
                          ? ` and ${formatCost(estimateCost(afterFix?.segments ?? 1, reachable))}`
                          : ""}
                        .
                      </>
                    ) : (
                      "."
                    )}
                  </p>
                  {fixable.length > 0 && (
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => setBody(toGsmSafe(body))}
                      >
                        <Wand2 className="h-3.5 w-3.5" />
                        Fix characters
                      </Button>
                      <span className="text-ink-faint">
                        Swaps {fixable.length} typographic character
                        {fixable.length === 1 ? "" : "s"} for ASCII twins
                        {afterFix
                          ? ` → ${afterFix.encoding}, ${afterFix.segments} segment${
                              afterFix.segments === 1 ? "" : "s"
                            }`
                          : ""}
                        . Never applied on its own — it&apos;s your copy, and you
                        may have meant it.
                      </span>
                    </div>
                  )}
                  {unfixable.length > 0 && (
                    <p className="mt-1.5 text-ink-faint">
                      {unfixable.join(" ")}{" "}
                      {unfixable.length === 1 ? "has" : "have"} no ASCII
                      equivalent, so {unfixable.length === 1 ? "deleting it" : "deleting them"}{" "}
                      is the only way back to GSM-7.
                    </p>
                  )}
                </div>
              )}

              {disclosureApplies && (
                <p className="mt-2 text-xs text-ink-faint">
                  The first text a number ever receives also carries “{helpText}”
                  — CTIA wants the brand, an opt-out and a rates line in it. For
                  those recipients this message is {firstTimeSegments} segment
                  {firstTimeSegments === 1 ? "" : "s"}. Name batch0, say
                  &ldquo;Reply STOP to opt out&rdquo; and &ldquo;Msg &amp; data
                  rates may apply&rdquo; in the body yourself and the transport
                  leaves it alone.
                </p>
              )}
            </div>
          </Card>

          {/* ---------------- when, test, send ---------------- */}
          <Card className="space-y-5">
            <div>
              <Label htmlFor="sms-when">Send</Label>
              <div className="flex flex-wrap items-center gap-3">
                <Select
                  id="sms-when"
                  value={sendAt ? "later" : "now"}
                  onChange={(e) =>
                    setSendAt(e.target.value === "now" ? "" : defaultScheduleValue())
                  }
                  className="max-w-[200px]"
                >
                  <option value="now">On the next queue run</option>
                  <option value="later">At a specific time</option>
                </Select>
                {sendAt && (
                  <Input
                    type="datetime-local"
                    value={sendAt}
                    onChange={(e) => setSendAt(e.target.value)}
                    className="max-w-[240px]"
                    aria-label="Send after"
                  />
                )}
              </div>
              <p className="mt-1.5 text-xs text-ink-faint">
                {sendAt
                  ? "In your local time. Each row waits until then AND until it's inside that recipient's own quiet-hours window, whichever is later."
                  : `Queued immediately and drained in the background from ${fromNumber}. Nothing is sent inside this request — a 300-person campaign can't finish in one.`}
              </p>
            </div>

            {/* The step that stops a mistyped blast. Required, not suggested. */}
            <div className="rounded-lg border border-line bg-paper p-4">
              <Label htmlFor="sms-test-phone" required>
                Test it on a real phone
              </Label>
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  id="sms-test-phone"
                  type="tel"
                  inputMode="tel"
                  maxLength={PHONE_MAX_LENGTH}
                  value={testPhone}
                  onChange={(e) => setTestPhone(e.target.value)}
                  placeholder="(555) 123-4567"
                  className="max-w-[200px]"
                />
                <Button
                  variant="secondary"
                  onClick={onTest}
                  disabled={
                    testing ||
                    !body.trim() ||
                    overCeiling ||
                    !isValidPhone(testPhone)
                  }
                >
                  <FlaskConical className="h-4 w-4" />
                  {testing ? "Sending…" : "Send test"}
                </Button>
              </div>
              {/* A consent box like any other: unchecked, its own sentence, and
                  recorded in the ledger in the admin's name when ticked. Without
                  it a test can only reach a number that opted in through a
                  student application, which staff don't have. */}
              <label className="mt-2 flex cursor-pointer gap-2 text-xs text-ink-soft">
                <input
                  type="checkbox"
                  checked={ownNumber}
                  onChange={(e) => setOwnNumber(e.target.checked)}
                  className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-phosphor"
                />
                <span>{ADMIN_TEST_CONSENT}</span>
              </label>
              <p className="mt-1.5 text-xs text-ink-faint">
                The real message, through the real transport, to one number that
                has agreed to texts. Read it on the phone before you spend
                anything — that is the only place a wrong word looks wrong.
              </p>

              {test && !test.outcome.ran && (
                <p className="mt-2 text-xs text-red-700 dark:text-red-300">
                  {test.outcome.error}
                </p>
              )}
              {test && test.outcome.ran && (
                <div
                  className={`mt-2 rounded-md border px-3 py-2 text-xs ${
                    test.outcome.result.ok
                      ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300"
                      : test.outcome.chainProven
                        ? "border-amber-500/40 bg-amber-500/[0.06] text-amber-700 dark:text-amber-200"
                        : "border-red-500/30 bg-red-500/5 text-red-700 dark:text-red-300"
                  }`}
                >
                  {test.outcome.result.ok ? (
                    <>
                      Sent to {test.outcome.to}
                      {/* The transport re-measures after appending the
                          first-message disclosure, so this can legitimately be
                          one more than the counter above. */}
                      {test.outcome.result.segments
                        ? ` — ${test.outcome.result.segments} segment${
                            test.outcome.result.segments === 1 ? "" : "s"
                          } on the wire`
                        : ""}
                      . Check the phone.
                    </>
                  ) : (
                    <>
                      {test.outcome.to}: {test.outcome.result.reason}
                      {test.outcome.result.queuedFor && (
                        <> Queued for {formatLocal(test.outcome.result.queuedFor)}.</>
                      )}
                      {!test.outcome.chainProven &&
                        (test.outcome.result.queuedReason === "paused" ? (
                          <p className="mt-1">
                            Sending is paused, so the test is parked in the
                            outbox and nothing about the campaign is proven.
                            Resume sending in{" "}
                            <Link href="/admin/sms/settings" className="underline">
                              Settings
                            </Link>{" "}
                            and test again.
                          </p>
                        ) : (
                          <p className="mt-1">
                            Nothing reached the provider, so nothing is proven yet.
                            If that number hasn&apos;t agreed to texts and it&apos;s
                            yours, tick the box above and send again; otherwise
                            check{" "}
                            <Link href="/admin/sms/settings" className="underline">
                              Settings
                            </Link>
                            .
                          </p>
                        ))}
                    </>
                  )}
                </div>
              )}
              {test && test.outcome.ran && test.outcome.chainProven && !tested && (
                <p className="mt-2 text-xs text-amber-700 dark:text-amber-200">
                  The message changed after that test, so it no longer proves the
                  copy. Send another one.
                </p>
              )}
            </div>

            {!ready && (
              <ul className="space-y-1 text-xs text-ink-faint">
                {blockers.map((b) => (
                  <li key={b}>· {b}</li>
                ))}
              </ul>
            )}

            <div>
              <Button
                className="w-full"
                disabled={!ready || pending}
                onClick={() => setConfirming(true)}
              >
                <Send className="h-4 w-4" />
                {pending
                  ? "Queueing…"
                  : `${sendAt ? "Schedule" : "Send"} to ${describeRecipients(
                      reachable,
                    )} · ${formatCost(cost)}`}
              </Button>
              <p className="mt-2 text-center text-xs text-ink-faint">
                A text can&apos;t be recalled once the queue drains, and every
                segment is billed whether or not it was meant.
              </p>
            </div>
          </Card>
        </div>
      </div>

      <ConfirmDialog
        open={confirming}
        onCancel={() => setConfirming(false)}
        onConfirm={onSend}
        pending={pending}
        title={sendAt ? "Schedule this campaign?" : "Send this campaign?"}
        confirmLabel={sendAt ? "Schedule it" : "Send it"}
        description={
          <div className="space-y-2">
            <p>
              <strong className="font-semibold text-ink">
                {describeRecipients(reachable)}
              </strong>{" "}
              — their own numbers. {measured.segments} segment
              {measured.segments === 1 ? "" : "s"} each, about{" "}
              <strong className="font-semibold text-ink">
                {formatCost(cost)}
              </strong>
              .
            </p>
            {preview && preview.quiet.deferred > 0 && (
              <p>
                {preview.quiet.deferred} are outside their quiet-hours window and
                will wait
                {preview.quiet.firstSendLabel
                  ? ` until ${preview.quiet.firstSendLabel}`
                  : ""}
                .
              </p>
            )}
            <p className="text-ink-faint">
              The audience is resolved again on the server as this runs, so the
              final count can differ by anyone who opted out in the meantime.
              There is no undo.
            </p>
          </div>
        }
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

/** An ISO instant from the transport, in the admin's own zone. */
function formatLocal(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}
