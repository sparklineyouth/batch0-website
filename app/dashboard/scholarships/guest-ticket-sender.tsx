"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { getActionError } from "@/lib/action-error";
import { sendGuestTicketAction } from "./actions";

/**
 * The student's side of the Demo Day guest-ticket perk (0074): who has a
 * ticket from them already, and a small form to send the next one.
 *
 * No confirm step. A sent ticket is a real email to a real guest and can't be
 * unsent — but the address is typed in full right here, the count of what's
 * left is on screen, and the server refuses a duplicate address and anything
 * past the grant. A dialog on top of that would be ceremony.
 */
export function GuestTicketSender({
  remaining,
  sent,
}: {
  remaining: number;
  sent: Array<{ id: string; email: string; name: string | null; sentAt: string }>;
}) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [notice, setNotice] = useState<string | undefined>();
  const [pending, start] = useTransition();

  function send(e: React.FormEvent) {
    e.preventDefault();
    setError(undefined);
    setNotice(undefined);
    start(async () => {
      try {
        const res = await sendGuestTicketAction({ email, name });
        if (!res.ok) {
          setError(res.error);
          return;
        }
        const remaining = res.data?.remaining ?? 0;
        setNotice(
          `Sent to ${email.trim()}. ${
            remaining > 0 ? `${remaining} left.` : "That was your last one."
          }`,
        );
        setEmail("");
        setName("");
        router.refresh();
      } catch (err: any) {
        setError(getActionError(err));
      }
    });
  }

  return (
    <div className="space-y-3">
      {sent.length > 0 && (
        <ul className="space-y-1 text-sm text-ink-soft">
          {sent.map((t) => (
            <li key={t.id} className="flex flex-wrap items-baseline gap-x-2">
              <span className="text-ink">{t.name || t.email}</span>
              {t.name && <span className="text-xs text-ink-faint">{t.email}</span>}
              <span className="text-xs text-ink-faint">· sent</span>
            </li>
          ))}
        </ul>
      )}

      {remaining > 0 && (
        <form onSubmit={send} className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <div>
            <Label htmlFor="guest-email">Guest&apos;s email</Label>
            <Input
              id="guest-email"
              type="email"
              required
              value={email}
              disabled={pending}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="mum@example.com"
              className="h-9"
            />
          </div>
          <div>
            <Label htmlFor="guest-name">Their name (optional)</Label>
            <Input
              id="guest-name"
              value={name}
              disabled={pending}
              maxLength={120}
              onChange={(e) => setName(e.target.value)}
              placeholder="Priya"
              className="h-9"
            />
          </div>
          <Button type="submit" size="sm" disabled={pending || !email.trim()}>
            {pending ? "Sending…" : "Send ticket"}
          </Button>
        </form>
      )}

      {error && <p className="text-xs text-red-700 dark:text-red-300">{error}</p>}
      {notice && <p className="text-xs text-phosphor-ink">{notice}</p>}
    </div>
  );
}
