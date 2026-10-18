"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Play, RotateCcw, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { LocalTime } from "@/components/ui/local-time";
import { getActionError } from "@/lib/action-error";
import { maskE164 } from "@/lib/phone";
import {
  cancelCampaign,
  cancelQueuedSms,
  retryFailedSms,
  runSmsQueueNow,
} from "./actions";

/**
 * The message log, and the two controls that act on it.
 *
 * Client-side because every row carries an action and the result has to land
 * somewhere the reader is already looking — there is no toast primitive in this
 * project, so a failed cancel writes its reason into the row it failed on (the
 * inline-notice pattern from app/admin/email/compose/compose-form.tsx).
 */

// Same vocabulary and the same colours as the email outbox, deliberately: an
// admin who has learned to read one queue should not have to learn a second.
// `skipped` is amber rather than red because it is usually the consent gate
// working correctly, not a fault.
const STATUS_STYLES: Record<string, string> = {
  pending: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  sending: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  sent: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  failed: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300",
  canceled: "border-line bg-wash text-ink-faint",
  skipped: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
};

/** What the server page hands over. Plain values only — this crosses the RSC boundary. */
export type SmsOutboxRow = {
  id: string;
  toPhone: string;
  toName: string | null;
  segments: number;
  status: string;
  attempts: number;
  lastError: string | null;
  sendAfter: string;
  sentAt: string | null;
  templateKey: string | null;
  campaignId: string | null;
  campaignName: string | null;
};

export function SmsQueueControls({
  pendingCount,
  campaign,
}: {
  pendingCount: number;
  /** Set only when the page is filtered to one campaign. */
  campaign?: { id: string; name: string; status: string } | null;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<string>();
  const [failed, setFailed] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);

  function run(fn: () => Promise<{ ok: boolean; message?: string; error?: string }>) {
    start(async () => {
      setMessage(undefined);
      try {
        const res = await fn();
        setFailed(!res.ok);
        setMessage(res.message ?? res.error ?? (res.ok ? "Done." : "Failed."));
        router.refresh();
      } catch (err) {
        setFailed(true);
        setMessage(getActionError(err));
      }
    });
  }

  const cancellable =
    campaign && campaign.status !== "canceled" && campaign.status !== "done";

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="secondary" onClick={() => run(runSmsQueueNow)} disabled={pending}>
        <Play className="h-4 w-4" /> {pending ? "Draining…" : "Run queue now"}
      </Button>
      {cancellable && (
        <Button
          variant="danger"
          size="sm"
          onClick={() => setConfirmCancel(true)}
          disabled={pending}
        >
          <XCircle className="h-4 w-4" /> Stop this campaign
        </Button>
      )}
      {message && (
        <span
          role="status"
          className={`text-xs ${
            failed ? "text-red-500" : "text-emerald-600 dark:text-emerald-400"
          }`}
        >
          {message}
        </span>
      )}

      {campaign && (
        <ConfirmDialog
          open={confirmCancel}
          onCancel={() => setConfirmCancel(false)}
          onConfirm={() => {
            setConfirmCancel(false);
            run(() => cancelCampaign(campaign.id));
          }}
          title={`Stop “${campaign.name}”?`}
          description={`Every one of the ${pendingCount} message${
            pendingCount === 1 ? "" : "s"
          } still queued for this campaign will be cancelled, and the campaign closes. Texts already sent can't be recalled, and anything mid-send will finish.`}
          confirmLabel="Stop the campaign"
          pending={pending}
          destructive
        />
      )}
    </div>
  );
}

/**
 * Every row is a program text to a student's own number (lib/sms/policy.ts),
 * so there is no purpose or party column: a column that can only ever say one
 * thing is a column nobody reads, right up until the day it says something
 * else and nobody notices.
 */
export function SmsOutboxTable({
  rows,
  maxAttempts,
}: {
  rows: SmsOutboxRow[];
  /** MAX_ATTEMPTS from lib/sms/queue.ts, passed down — that module is server-only. */
  maxAttempts: number;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line text-left text-xs uppercase tracking-wider text-ink-faint">
            <th className="px-5 py-3">Number</th>
            <th className="px-5 py-3">Name</th>
            <th className="px-5 py-3 text-right">Seg</th>
            <th className="px-5 py-3">Status</th>
            <th className="px-5 py-3 text-right">Tries</th>
            <th className="px-5 py-3">Last error</th>
            <th className="px-5 py-3">Due</th>
            <th className="px-5 py-3">Sent</th>
            <th className="px-5 py-3"></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-b border-line last:border-0 hover:bg-wash">
              {/* Masked, always. This page is a list — it gets left open on a
                  shared screen, screenshotted into chat, and read by anyone with
                  sms.view — and most of these numbers belong to minors. The
                  last four digits are enough to match a row
                  against a person you are already on the phone with, which is
                  the only reason anyone needs the number here. The full value
                  lives in the database and nowhere in the UI. */}
              <td className="whitespace-nowrap px-5 py-3 font-mono text-xs text-ink">
                {maskE164(r.toPhone)}
              </td>
              <td className="px-5 py-3 text-ink-soft">
                {r.toName || <span className="text-ink-faint">—</span>}
                {/* The campaign's name filters the outbox to it — the only view
                    that answers "who didn't get it and why", and where a
                    campaign can be stopped. */}
                {r.campaignId && r.campaignName ? (
                  <Link
                    href={`/admin/sms/outbox?campaign=${r.campaignId}`}
                    className="block text-[11px] text-ink-faint underline-offset-2 hover:text-ink hover:underline"
                  >
                    {r.campaignName}
                  </Link>
                ) : (
                  r.templateKey && (
                    <div className="text-[11px] text-ink-faint">{r.templateKey}</div>
                  )
                )}
              </td>
              <td className="px-5 py-3 text-right tabular-nums text-ink-soft">
                {r.segments}
              </td>
              <td className="px-5 py-3">
                <span
                  className={`inline-block rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${
                    STATUS_STYLES[r.status] ?? "border-line text-ink-faint"
                  }`}
                >
                  {r.status}
                </span>
              </td>
              <td className="px-5 py-3 text-right tabular-nums text-ink-faint">
                {r.attempts}
              </td>
              <td
                className="max-w-[240px] truncate px-5 py-3 text-xs text-ink-faint"
                title={r.lastError ?? ""}
              >
                {r.lastError ?? "—"}
              </td>
              <td className="whitespace-nowrap px-5 py-3 text-xs text-ink-soft">
                <LocalTime value={r.sendAfter} mode="datetime-short" />
              </td>
              <td className="whitespace-nowrap px-5 py-3 text-xs text-ink-soft">
                <LocalTime value={r.sentAt} mode="datetime-short" />
              </td>
              <td className="px-5 py-3">
                <RowAction
                  id={r.id}
                  status={r.status}
                  attempts={r.attempts}
                  maxAttempts={maxAttempts}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Per-row cancel / retry. Renders nothing for a row in a terminal state. */
function RowAction({
  id,
  status,
  attempts,
  maxAttempts,
}: {
  id: string;
  status: string;
  attempts: number;
  maxAttempts: number;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string>();

  const canCancel = status === "pending";
  // The server refuses past the cap too — this only keeps the button from
  // offering an action it knows will be turned down.
  const canRetry = status === "failed" && attempts < maxAttempts;
  if (!canCancel && !canRetry) return null;

  return (
    <div className="flex items-center justify-end gap-3">
      {error && (
        <span className="max-w-[260px] text-xs text-red-500" role="alert">
          {error}
        </span>
      )}
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          start(async () => {
            setError(undefined);
            try {
              const res = canCancel
                ? await cancelQueuedSms(id)
                : await retryFailedSms(id);
              if (!res.ok) setError(res.error ?? "Failed");
              else router.refresh();
            } catch (err) {
              setError(getActionError(err));
            }
          })
        }
        className="inline-flex items-center gap-1 text-xs font-semibold text-ink-soft hover:text-ink disabled:opacity-50"
      >
        {canCancel ? (
          <>
            <XCircle className="h-3.5 w-3.5" /> Cancel
          </>
        ) : (
          <>
            <RotateCcw className="h-3.5 w-3.5" /> Retry
          </>
        )}
      </button>
    </div>
  );
}
