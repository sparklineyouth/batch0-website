"use client";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { getActionError } from "@/lib/action-error";
import { withdrawScholarshipApplicationAction } from "./actions";

/**
 * Withdraw a scholarship application that hasn't been decided.
 *
 * Two-step rather than a confirm() dialog: a browser modal blocks the whole
 * tab, and this is a small enough action that an inline "sure?" is honest
 * without being heavy. The server refuses anyway once a decision is recorded,
 * so the worst a stale click can do is show an error.
 */
export function WithdrawButton({ applicationId }: { applicationId: string }) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [pending, start] = useTransition();

  function onWithdraw() {
    setError(undefined);
    start(async () => {
      try {
        const res = await withdrawScholarshipApplicationAction(applicationId);
        if (!res.ok) {
          setError(res.error);
          setConfirming(false);
        }
      } catch (err: any) {
        setError(getActionError(err));
        setConfirming(false);
      }
    });
  }

  if (error) {
    return <span className="text-xs text-red-500">{error}</span>;
  }

  if (!confirming) {
    return (
      <Button size="sm" variant="ghost" onClick={() => setConfirming(true)}>
        Withdraw
      </Button>
    );
  }

  return (
    <span className="inline-flex items-center gap-1">
      <Button size="sm" variant="danger" disabled={pending} onClick={onWithdraw}>
        {pending ? "Withdrawing…" : "Confirm"}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabled={pending}
        onClick={() => setConfirming(false)}
      >
        Cancel
      </Button>
    </span>
  );
}
