"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea, FieldError } from "@/components/ui/input";
import {
  counterSignOffer,
  declineOffer,
} from "@/app/dashboard/team/offers/actions";
import { getActionError } from "@/lib/action-error";

export function OfferActions({ offerId }: { offerId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | undefined>();
  const [signatureName, setSignatureName] = useState("");
  const [declineReason, setDeclineReason] = useState("");
  const [showDecline, setShowDecline] = useState(false);
  const [confirmSign, setConfirmSign] = useState(false);

  function sign() {
    if (!confirmSign) {
      setError(
        "Tick the acknowledgement first. This is a binding commitment once signed.",
      );
      return;
    }
    setError(undefined);
    start(async () => {
      try {
        await counterSignOffer({ offerId, signatureName });
        router.refresh();
      } catch (e) {
        setError(getActionError(e));
      }
    });
  }

  function decline() {
    setError(undefined);
    start(async () => {
      try {
        await declineOffer(offerId, declineReason || null);
        router.refresh();
      } catch (e) {
        setError(getActionError(e));
      }
    });
  }

  return (
    <div className="mt-4 space-y-5">
      <div>
        <Label>Counter-sign</Label>
        <p className="mt-0.5 text-xs text-ink-faint">
          By typing your full legal name and clicking <em>Counter-sign</em>,
          you accept the offer on behalf of the team. batch0 logs the
          timestamp + IP as evidence of execution.
        </p>
        <Input
          value={signatureName}
          onChange={(e) => setSignatureName(e.target.value)}
          placeholder="Type your full legal name"
          className="mt-2"
        />
        <label className="mt-3 flex items-start gap-2 text-xs text-ink-soft">
          <input
            type="checkbox"
            checked={confirmSign}
            onChange={(e) => setConfirmSign(e.target.checked)}
            className="mt-0.5"
          />
          I confirm I have read the memo, am authorized to sign on behalf of
          the team, and understand this creates a binding commitment.
        </label>
        <Button
          className="mt-3"
          onClick={sign}
          disabled={pending || !signatureName.trim()}
        >
          {pending ? "Signing…" : "Counter-sign"}
        </Button>
      </div>

      <div className="border-t border-line pt-5">
        {!showDecline ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowDecline(true)}
            disabled={pending}
          >
            Decline this offer
          </Button>
        ) : (
          <div>
            <Label>Decline with optional note</Label>
            <Textarea
              rows={3}
              value={declineReason}
              onChange={(e) => setDeclineReason(e.target.value)}
              placeholder="What didn't work? Helps investors come back with a better offer."
            />
            <div className="mt-3 flex gap-2">
              <Button
                variant="danger"
                onClick={decline}
                disabled={pending}
              >
                {pending ? "Declining…" : "Decline"}
              </Button>
              <Button
                variant="ghost"
                onClick={() => setShowDecline(false)}
                disabled={pending}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}
      </div>

      {error && <FieldError>{error}</FieldError>}
    </div>
  );
}
