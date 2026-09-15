"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  Input,
  Textarea,
  Label,
  Select,
  FieldError,
} from "@/components/ui/input";
import { getActionError } from "@/lib/action-error";
import {
  normalizeTicketEmail,
  parseTicketAmount,
  TICKET_NAME_MAX,
  TICKET_NOTE_MAX,
} from "@/lib/demo-day-ticket-input";
import { sendDemoDayTicket, type SendTicketResult } from "./actions";
import { CopyLinkButton } from "./copy-link-button";

type CohortOption = { id: string; name: string };

/**
 * "Send someone a Demo Day ticket." Name, email, price, which Demo Day, an
 * optional note — then one button. The server re-validates everything; the
 * checks here just save a round trip for the obvious mistakes.
 */
export function TicketForm({
  cohorts,
  defaultCohortId,
  initialName,
  initialEmail,
}: {
  cohorts: CohortOption[];
  defaultCohortId: string | null;
  /** Prefilled when arriving from a person's page. */
  initialName?: string;
  initialEmail?: string;
}) {
  const router = useRouter();
  const [name, setName] = useState(initialName ?? "");
  const [email, setEmail] = useState(initialEmail ?? "");
  const [amount, setAmount] = useState("25");
  const [cohortId, setCohortId] = useState(defaultCohortId ?? "");
  const [note, setNote] = useState("");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | undefined>();
  const [last, setLast] = useState<Extract<SendTicketResult, { ok: true }> | null>(null);

  function submit() {
    setError(undefined);
    setLast(null);
    if (!normalizeTicketEmail(email)) return setError("Enter a valid email address.");
    if (parseTicketAmount(amount) == null) {
      return setError("Enter a price between $0.50 and $10,000.");
    }
    start(async () => {
      try {
        const res = await sendDemoDayTicket({
          name,
          email,
          amount,
          cohortId: cohortId || null,
          note,
        });
        if (!res.ok) return setError(res.error);
        setLast(res);
        setName("");
        setEmail("");
        setNote("");
        router.refresh();
      } catch (e: any) {
        setError(getActionError(e));
      }
    });
  }

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <div>
        <Label>Name</Label>
        <Input
          value={name}
          maxLength={TICKET_NAME_MAX}
          onChange={(e) => setName(e.target.value)}
          placeholder="Who it's for (optional)"
          autoComplete="off"
        />
      </div>
      <div>
        <Label>Email</Label>
        <Input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="Where the pay link goes"
          autoComplete="off"
          required
        />
      </div>
      <div>
        <Label>Price (USD)</Label>
        <Input
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="25"
        />
        <p className="mt-1 text-[11px] text-ink-faint">
          Any amount from $0.50. This is what Stripe will charge.
        </p>
      </div>
      <div>
        <Label>Demo Day</Label>
        <Select value={cohortId} onChange={(e) => setCohortId(e.target.value)}>
          <option value="">Any cohort&rsquo;s Demo Day</option>
          {cohorts.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
      </div>
      <div className="md:col-span-2">
        <Label>Note (optional, included in the email)</Label>
        <Textarea
          rows={2}
          value={note}
          maxLength={TICKET_NOTE_MAX}
          onChange={(e) => setNote(e.target.value)}
          placeholder="e.g. Would love to have you in the room for the pitches."
        />
      </div>
      <div className="md:col-span-2 flex flex-wrap items-center gap-3">
        <Button onClick={submit} disabled={pending}>
          {pending ? "Sending…" : "Send ticket"}
        </Button>
        {last && (
          <span className="flex flex-wrap items-center gap-2 text-xs">
            {last.emailed ? (
              <span className="text-emerald-700 dark:text-emerald-300">
                Sent. They&rsquo;ll get the pay link by email.
              </span>
            ) : (
              <span className="text-amber-700 dark:text-amber-300">
                Ticket created, but the email didn&rsquo;t send
                {last.emailReason ? ` (${last.emailReason})` : ""}. Copy the
                link and send it yourself, or hit Resend below.
              </span>
            )}
            <CopyLinkButton url={last.url} />
          </span>
        )}
      </div>
      {error && <FieldError>{error}</FieldError>}
    </div>
  );
}
