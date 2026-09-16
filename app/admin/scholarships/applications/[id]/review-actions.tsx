"use client";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input, Textarea, Label } from "@/components/ui/input";
import { getActionError } from "@/lib/action-error";
import { formatMoney } from "@/lib/scholarship-award";
import {
  awardScholarshipAction,
  declineScholarshipAction,
  revokeScholarshipAwardAction,
  issueScholarshipRefundAction,
} from "../../actions";

/**
 * The decision panel.
 *
 * Awarding and refunding are deliberately two buttons, in two states, with the
 * refund behind its own typed-out confirmation. Awarding is a judgement call
 * that can be revoked; issuing a refund moves real money off a real card and
 * cannot. Collapsing them into one click would mean a misclick on a review
 * screen refunds someone — and the review screen is exactly where a person is
 * clicking quickly through a queue.
 */
export function ReviewActions({
  applicationId,
  status,
  fulfillment,
  awardType,
  projectedCents,
  awardCents,
  refundedCents,
  hasPaid,
  paidCents,
  creditsUsed,
  studentName,
  defaultNote,
}: {
  applicationId: string;
  status: string;
  fulfillment: string;
  awardType: string;
  /** What awarding would be worth, computed the way the action computes it. */
  projectedCents: number;
  awardCents: number;
  refundedCents: number;
  hasPaid: boolean;
  paidCents: number;
  creditsUsed: number;
  studentName: string;
  defaultNote: string;
}) {
  const router = useRouter();
  const [note, setNote] = useState(defaultNote);
  const [override, setOverride] = useState("");
  const [confirmRefund, setConfirmRefund] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [ok, setOk] = useState<string | undefined>();
  const [pending, start] = useTransition();

  function run(
    fn: () => Promise<{ ok: boolean; error?: string; data?: any }>,
    onOk?: (data: any) => string,
  ) {
    setError(undefined);
    setOk(undefined);
    start(async () => {
      try {
        const res = await fn();
        if (!res.ok) {
          setError(res.error);
          setConfirmRefund(false);
          setConfirmRevoke(false);
          return;
        }
        if (onOk) setOk(onOk(res.data));
        setConfirmRefund(false);
        setConfirmRevoke(false);
        router.refresh();
      } catch (err: any) {
        setError(getActionError(err));
        setConfirmRefund(false);
        setConfirmRevoke(false);
      }
    });
  }

  const decidable = status === "submitted" || status === "under_review";
  const awarded = status === "awarded";
  const isMoney = awardType === "discount";
  const refundOwed = awarded && fulfillment === "refund_due";
  const refunded = fulfillment === "refunded";

  // The amount the refund button will actually move. Mirrors awardRefundCents:
  // bounded by what they paid, minus what has already gone back.
  const refundable = Math.max(0, Math.min(paidCents - refundedCents, awardCents));
  const wouldBeFullRefund = refundable >= paidCents && paidCents > 0;

  return (
    <Card>
      <h2 className="text-sm font-medium text-ink">Decide</h2>

      <div className="mt-4">
        <Label htmlFor="rv-note">
          Note to the student {decidable ? "(goes in the email)" : ""}
        </Label>
        <Textarea
          id="rv-note"
          rows={3}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={
            decidable
              ? "Optional. Appears in the email they get, so write it to them."
              : "Optional."
          }
        />
      </div>

      {decidable && isMoney && (
        <div className="mt-4 max-w-xs">
          <Label htmlFor="rv-override">Award a different amount ($)</Label>
          <Input
            id="rv-override"
            type="number"
            min={0}
            step="1"
            value={override}
            onChange={(e) => setOverride(e.target.value)}
            placeholder={String(projectedCents / 100)}
          />
          <p className="mt-1 text-xs text-ink-faint">
            Leave blank for the scholarship's own terms
            {projectedCents > 0 && ` (${formatMoney(projectedCents)})`}. A number
            here replaces them for this student only.
          </p>
        </div>
      )}

      {error && (
        <p className="mt-4 rounded-lg border border-red-400/30 bg-red-400/5 px-3 py-2 text-xs text-red-300">
          {error}
        </p>
      )}
      {ok && (
        <p className="mt-4 rounded-lg border border-emerald-400/30 bg-emerald-400/5 px-3 py-2 text-xs text-emerald-300">
          {ok}
        </p>
      )}

      {decidable && (
        <div className="mt-5 flex flex-wrap items-center gap-2">
          <Button
            disabled={pending}
            onClick={() =>
              run(
                () =>
                  awardScholarshipAction({
                    applicationId,
                    note,
                    overrideDollars: override,
                  }),
                (data) =>
                  data?.refundDueCents > 0
                    ? `Awarded. ${formatMoney(data.refundDueCents)} is now owed as a refund — issue it below.`
                    : "Awarded. They've been emailed.",
              )
            }
          >
            {pending ? "Working…" : "Award it"}
          </Button>
          <Button
            variant="secondary"
            disabled={pending}
            onClick={() =>
              run(
                () => declineScholarshipAction({ applicationId, note }),
                () => "Declined. They've been emailed.",
              )
            }
          >
            Decline
          </Button>
        </div>
      )}

      {awarded && (
        <div className="mt-5 space-y-4">
          {refundOwed && (
            <div className="rounded-xl border border-amber-400/40 bg-amber-400/5 p-4">
              <h3 className="text-sm font-medium text-amber-300">
                A refund is owed
              </h3>
              <p className="mt-1 text-sm text-ink-soft">
                {studentName} paid {formatMoney(paidCents)} and has been awarded{" "}
                {formatMoney(awardCents)}. Nothing has moved yet — pressing the
                button below issues a <strong>real partial refund</strong> to
                their card. It can't be undone from here.
              </p>
              <p className="mt-2 text-xs text-ink-faint">
                Their enrollment is unaffected: a partial refund leaves it
                standing, and we refuse a refund for the full amount precisely
                because that one would cancel it.
              </p>

              {wouldBeFullRefund ? (
                <p className="mt-3 text-xs text-amber-300">
                  This award is the full amount they paid, so it can't be issued
                  here — a full refund would cancel their enrollment. Do it from{" "}
                  <a href="/admin/payments" className="underline">
                    /admin/payments
                  </a>{" "}
                  if that's really what you mean.
                </p>
              ) : !confirmRefund ? (
                <Button
                  className="mt-4"
                  disabled={pending}
                  onClick={() => setConfirmRefund(true)}
                >
                  Issue {formatMoney(refundable)} refund
                </Button>
              ) : (
                <div className="mt-4 flex flex-wrap items-center gap-2">
                  <span className="text-sm text-ink">
                    Refund {formatMoney(refundable)} to {studentName}'s card?
                  </span>
                  <Button
                    variant="danger"
                    disabled={pending}
                    onClick={() =>
                      run(
                        () => issueScholarshipRefundAction(applicationId),
                        (data) =>
                          `${formatMoney(data?.amountCents ?? refundable)} refunded. They've been emailed.`,
                      )
                    }
                  >
                    {pending ? "Refunding…" : "Yes, refund it"}
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={pending}
                    onClick={() => setConfirmRefund(false)}
                  >
                    Cancel
                  </Button>
                </div>
              )}
            </div>
          )}

          {refunded && (
            <p className="rounded-lg border border-line bg-wash px-3 py-2 text-sm text-ink-soft">
              {formatMoney(refundedCents)} was refunded to their card. Their
              enrollment is unchanged.
            </p>
          )}

          {!hasPaid && isMoney && (
            <p className="rounded-lg border border-line bg-wash px-3 py-2 text-sm text-ink-soft">
              They haven't paid yet, so {formatMoney(awardCents)} comes off their
              checkout automatically. Nothing to do.
            </p>
          )}

          <div className="border-t border-line pt-4">
            {refundedCents > 0 ? (
              <p className="text-xs text-ink-faint">
                This award can't be revoked — the money has already gone back.
                Reverse it from{" "}
                <a href="/admin/payments" className="underline">
                  /admin/payments
                </a>{" "}
                if you need to.
              </p>
            ) : creditsUsed > 0 ? (
              <p className="text-xs text-ink-faint">
                This award can't be revoked — they've already used{" "}
                {creditsUsed} of their mentor calls.
              </p>
            ) : !confirmRevoke ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={pending}
                onClick={() => setConfirmRevoke(true)}
              >
                Revoke this award
              </Button>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm text-ink">
                  Put this back to undecided?
                </span>
                <Button
                  size="sm"
                  variant="danger"
                  disabled={pending}
                  onClick={() =>
                    run(
                      () =>
                        revokeScholarshipAwardAction({ applicationId, note }),
                      () => "Revoked. It's back in the queue.",
                    )
                  }
                >
                  {pending ? "Revoking…" : "Revoke"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={pending}
                  onClick={() => setConfirmRevoke(false)}
                >
                  Cancel
                </Button>
              </div>
            )}
          </div>
        </div>
      )}

      {!decidable && !awarded && (
        <p className="mt-5 text-sm text-ink-soft">
          This application is {status} — there's nothing to decide.
        </p>
      )}
    </Card>
  );
}
