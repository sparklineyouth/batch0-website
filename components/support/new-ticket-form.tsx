"use client";
import { useState, useTransition } from "react";
import Link from "next/link";
import { CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { submitSupportTicket } from "@/app/support/actions";
import {
  CATEGORY_HINTS,
  CATEGORY_LABELS,
  RECEIPT_REF_MAX,
  TICKET_BODY_MAX,
  TICKET_CATEGORIES,
  TICKET_SUBJECT_MAX,
  wantsReceiptRef,
  type TicketCategory,
} from "@/lib/support-access";

/**
 * The request form.
 *
 * Built around one idea: the person filling this in is usually having a bad
 * time — they can't log in, they were charged twice, they want their money
 * back — so every field earns its place and the category is chosen for them
 * whenever the link they arrived on knows the answer. The legal pages link
 * here with ?topic=refund, ?topic=privacy and so on, which is why `initial`
 * exists.
 *
 * The success state replaces the form rather than sitting under it, and it
 * leads with the reference. For a refund that reference and its timestamp are
 * the requester's proof under app/(legal)/refund-policy, so the confirmation
 * has to read like a receipt, not a thank-you note.
 */
export function NewTicketForm({
  initial = "other",
  accountEmail,
}: {
  initial?: TicketCategory;
  /** Shown read-only, so it's obvious where the reply will go. */
  accountEmail: string;
}) {
  const [category, setCategory] = useState<TicketCategory>(initial);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [receiptRef, setReceiptRef] = useState("");
  const [err, setErr] = useState<string | undefined>();
  const [done, setDone] = useState<{ reference: string; threadPath: string } | null>(
    null,
  );
  const [pending, start] = useTransition();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(undefined);
    start(async () => {
      const res = await submitSupportTicket({
        category,
        subject,
        body,
        receiptRef: wantsReceiptRef(category) ? receiptRef : null,
      });
      if (res.ok && res.data) setDone(res.data);
      else if (!res.ok) setErr(res.error);
    });
  }

  if (done) {
    return (
      <div
        role="status"
        aria-live="polite"
        className="rounded-xl border border-phosphor/30 bg-phosphor/5 p-6"
      >
        <p className="flex items-center gap-2 text-lg font-semibold text-phosphor-ink">
          <CheckCircle2 className="h-5 w-5" />
          We&rsquo;ve got it
        </p>
        <p className="mt-3 text-sm text-ink-soft">
          Your reference is{" "}
          <strong className="font-mono text-ink">{done.reference}</strong>. We
          emailed a copy to <strong className="text-ink">{accountEmail}</strong>{" "}
          with a private link to the thread — keep it, and quote the reference
          if you contact us any other way.
        </p>
        {category === "refund" && (
          <p className="mt-3 text-sm text-ink-soft">
            Because this is a refund request, the time we recorded it is the
            time that counts against the 48-hour window in our{" "}
            <Link href="/refund-policy" className="link-ink">
              refund policy
            </Link>
            . That&rsquo;s on the thread and in the email.
          </p>
        )}
        <div className="mt-5 flex flex-wrap gap-2">
          <Link
            href={done.threadPath}
            prefetch={false}
            className="inline-flex h-10 select-none items-center justify-center gap-2 whitespace-nowrap rounded-md bg-phosphor px-4 text-sm font-semibold leading-none text-on-phosphor shadow-cta hover:bg-phosphor-200 active:scale-[0.98]"
          >
            Open your request
          </Link>
          <Link
            href="/dashboard/support"
            prefetch={false}
            className="inline-flex h-10 select-none items-center justify-center gap-2 whitespace-nowrap rounded-md border border-line bg-paper px-4 text-sm font-semibold leading-none text-ink hover:border-ink/30 hover:bg-wash active:scale-[0.98]"
          >
            All your requests
          </Link>
        </div>
      </div>
    );
  }

  const needsReceipt = wantsReceiptRef(category);

  return (
    <form onSubmit={submit} noValidate>
      <div>
        <Label htmlFor="support-category" required>
          What&rsquo;s this about
        </Label>
        <Select
          id="support-category"
          value={category}
          onChange={(e) => setCategory(e.target.value as TicketCategory)}
        >
          {TICKET_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {CATEGORY_LABELS[c]}
            </option>
          ))}
        </Select>
        <p className="mt-1.5 text-xs text-ink-faint">{CATEGORY_HINTS[category]}</p>
      </div>

      <div className="mt-5">
        <Label htmlFor="support-subject" required>
          Subject
        </Label>
        <Input
          id="support-subject"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          placeholder={
            category === "refund"
              ? "Refund request — tuition paid September 29"
              : "One line on what you need"
          }
          maxLength={TICKET_SUBJECT_MAX}
          autoComplete="off"
        />
      </div>

      {needsReceipt && (
        <div className="mt-5">
          <Label htmlFor="support-receipt">Receipt or transaction ID</Label>
          <Input
            id="support-receipt"
            value={receiptRef}
            onChange={(e) => setReceiptRef(e.target.value)}
            placeholder="cs_live_… or pi_… — or paste the whole receipt link"
            maxLength={RECEIPT_REF_MAX}
            className="font-mono text-xs"
            autoComplete="off"
          />
          <p className="mt-1.5 text-xs text-ink-faint">
            Optional but it speeds this up a lot. It&rsquo;s on your Stripe
            receipt email, or under{" "}
            <Link href="/dashboard/billing/receipts" className="link-ink">
              Billing → Receipts
            </Link>
            .
          </p>
        </div>
      )}

      <div className="mt-5">
        <Label htmlFor="support-body" required>
          What happened
        </Label>
        <Textarea
          id="support-body"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={7}
          maxLength={TICKET_BODY_MAX}
          placeholder={
            category === "refund"
              ? "When you paid, what you paid for, and that you'd like it refunded. You don't have to explain why — we don't ask."
              : "The more specific the better. What you expected, what happened instead, and anything you've already tried."
          }
        />
        <p className="mt-1.5 text-xs text-ink-faint">
          Don&rsquo;t include card numbers or passwords — we never need them.
        </p>
      </div>

      <div className="mt-5 rounded-lg border border-line bg-wash px-3 py-2.5 text-xs text-ink-soft">
        We&rsquo;ll reply to <strong className="text-ink">{accountEmail}</strong>
        , the address on your account.
      </div>

      {err && (
        <p
          role="alert"
          className="mt-4 text-sm text-red-700 dark:text-red-300"
        >
          {err}
        </p>
      )}

      <Button
        type="submit"
        size="lg"
        className="mt-5 w-full sm:w-auto"
        disabled={pending || !subject.trim() || !body.trim()}
        aria-busy={pending}
      >
        {pending ? "Sending…" : "Send request"}
      </Button>
    </form>
  );
}
