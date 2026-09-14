"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Loader2, Check, AlertTriangle } from "lucide-react";
import {
  sendPhoneRequestToAccepted,
  type PhoneRequestSendResult,
} from "./actions";

/**
 * The send button. Two clicks: the first arms it (so a stray click can't fire
 * a real email to real students), the second sends. After a send it re-reads
 * the page so the recipient count reflects who's left.
 */
export function PhoneRequestControl({ count }: { count: number }) {
  const router = useRouter();
  const [armed, setArmed] = useState(false);
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<PhoneRequestSendResult | null>(null);

  if (count === 0) {
    return (
      <p className="inline-flex items-center gap-2 text-sm text-ink-soft">
        <Check className="h-4 w-4 text-phosphor-ink" />
        Every accepted student already has a phone number on file — nothing to
        send.
      </p>
    );
  }

  function send() {
    setResult(null);
    startTransition(async () => {
      const res = await sendPhoneRequestToAccepted();
      setResult(res);
      setArmed(false);
      if (res.ok) router.refresh();
    });
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        {!armed ? (
          <Button type="button" onClick={() => setArmed(true)} disabled={pending}>
            Send request to {count} student{count === 1 ? "" : "s"}
          </Button>
        ) : (
          <>
            <Button
              type="button"
              onClick={send}
              disabled={pending}
              className="bg-phosphor text-on-phosphor"
            >
              {pending ? (
                <span className="inline-flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Sending…
                </span>
              ) : (
                `Confirm — email ${count} student${count === 1 ? "" : "s"}`
              )}
            </Button>
            <button
              type="button"
              onClick={() => setArmed(false)}
              disabled={pending}
              className="text-sm text-ink-soft hover:text-ink"
            >
              Cancel
            </button>
          </>
        )}
      </div>

      {result?.ok && (
        <p className="inline-flex items-center gap-2 text-sm font-medium text-phosphor-ink">
          <Check className="h-4 w-4" />
          Sent to {result.sent} student{result.sent === 1 ? "" : "s"}
          {result.failed.length > 0
            ? ` · ${result.failed.length} failed`
            : ""}
          .
        </p>
      )}
      {result && !result.ok && (
        <p className="inline-flex items-center gap-2 text-sm font-medium text-red-500">
          <AlertTriangle className="h-4 w-4" />
          {result.error}
        </p>
      )}
    </div>
  );
}
