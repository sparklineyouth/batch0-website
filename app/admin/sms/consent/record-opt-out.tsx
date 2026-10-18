"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ShieldOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { getActionError } from "@/lib/action-error";
import { PHONE_MAX_LENGTH, isValidPhone } from "@/lib/phone";
import { recordOptOut } from "./actions";

/**
 * "Someone asked us to stop texting this number" — the form that turns an
 * email, a support request or a guardian's call into a suppression the
 * transport actually checks. See recordOptOut for why it exists and who may
 * use it.
 */
export function RecordOptOutForm() {
  const router = useRouter();
  const [phone, setPhone] = useState("");
  const [note, setNote] = useState("");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(undefined);
    setNotice(undefined);
    start(async () => {
      try {
        const res = await recordOptOut({ phone, note });
        if (res.ok) {
          setNotice(res.notice);
          setPhone("");
          setNote("");
          router.refresh();
        } else {
          setError(res.error ?? "Something went wrong.");
        }
      } catch (err) {
        setError(getActionError(err));
      }
    });
  }

  return (
    <form onSubmit={submit} className="space-y-3" noValidate>
      <div>
        <h2 className="flex items-center gap-2 text-sm font-semibold text-ink">
          <ShieldOff className="h-4 w-4" /> Record an opt-out
        </h2>
        <p className="mt-0.5 text-xs text-ink-soft">
          For a request to stop that came by email, a support request, or from a
          parent or guardian. It takes effect at once, cancels anything queued to
          the number, and only a START from that phone can undo it. The policy
          gives us 10 business days; do it the day it arrives.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-[200px_minmax(0,1fr)]">
        <div>
          <Label htmlFor="opt-out-phone">Number</Label>
          <Input
            id="opt-out-phone"
            type="tel"
            inputMode="tel"
            maxLength={PHONE_MAX_LENGTH}
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="(555) 123-4567"
          />
        </div>
        <div>
          <Label htmlFor="opt-out-note">Who asked, and where</Label>
          <Input
            id="opt-out-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Support B0-4F2A-9C7K — parent asked us to stop texting their student"
            maxLength={500}
          />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="submit"
          variant="secondary"
          size="sm"
          disabled={pending || !isValidPhone(phone) || !note.trim()}
        >
          {pending ? "Recording…" : "Stop texting this number"}
        </Button>
        {notice && <span className="text-xs text-emerald-700 dark:text-emerald-300">{notice}</span>}
        {error && (
          <span className="text-xs text-red-700 dark:text-red-300" role="alert">
            {error}
          </span>
        )}
      </div>
    </form>
  );
}
