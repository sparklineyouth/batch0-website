"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Loader2, Check, AlertTriangle, Mail } from "lucide-react";
import { sendSmsOptInRequests, type OptInRequestResult } from "./actions";

/**
 * The opt-in-request send button. Two clicks — the first arms it, the second
 * sends: this puts real email in real students' inboxes, and a stray click is
 * unrecoverable.
 *
 * The label says "Email" on both clicks. An operator on the SMS page clicking
 * a button on the SMS page will assume it texts; the only defence against that
 * is naming the channel in the button itself, twice.
 */
export function CollectControl({ count }: { count: number }) {
  const router = useRouter();
  const [armed, setArmed] = useState(false);
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<OptInRequestResult | null>(null);

  if (count === 0) {
    return (
      <p className="inline-flex items-center gap-2 text-sm text-ink-soft">
        <Check className="h-4 w-4 text-phosphor-ink" />
        Nobody left to email — everyone we can ask has turned texts on.
      </p>
    );
  }

  function send() {
    setResult(null);
    startTransition(async () => {
      const res = await sendSmsOptInRequests();
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
            <Mail className="h-4 w-4" />
            Email {count} student{count === 1 ? "" : "s"} an opt-in request
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
                `Confirm — send ${count} email${count === 1 ? "" : "s"}`
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

      {armed && !pending && (
        <p className="text-xs text-ink-faint">
          Goes out as email, in the house template, and lands in the email
          outbox like any other send. Each one asks the student to add their
          mobile and turn texts on at{" "}
          <span className="font-mono">/dashboard/phone</span>. No text is sent.
        </p>
      )}

      {result?.ok && (
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-700 dark:text-emerald-300">
          Emailed {result.sent} student{result.sent === 1 ? "" : "s"}
          {result.failed.length > 0
            ? ` · ${result.failed.length} didn't go through`
            : ""}
          . Numbers appear here as people answer.
          {result.failed.length > 0 && (
            <ul className="mt-2 space-y-1 text-xs">
              {result.failed.map((f) => (
                <li key={f.to}>
                  <span className="font-mono">{f.to}</span> — {f.reason}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {result && !result.ok && (
        <div className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-700 dark:text-red-300">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{result.error}</span>
        </div>
      )}
    </div>
  );
}
