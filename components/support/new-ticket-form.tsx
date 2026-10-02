"use client";
import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { CheckCircle2, ShieldAlert } from "lucide-react";
import { Button, ButtonLink, buttonClasses } from "@/components/ui/button";
import { FieldError, Input, Label, Select, Textarea } from "@/components/ui/input";
import { getActionError } from "@/lib/action-error";
import {
  submitSupportRequest,
  type SubmitSupportRequestResult,
} from "@/app/support/actions";
import { AttachmentPicker } from "@/components/support/attachment-picker";
import {
  CATEGORY_GROUPS,
  CATEGORY_HINTS,
  CATEGORY_LABELS,
  RECEIPT_REF_MAX,
  TICKET_BODY_MAX,
  TICKET_BODY_MIN,
  TICKET_SUBJECT_MAX,
  codePointLength,
  formatReceivedAt,
  wantsReceiptRef,
  type SupportSurface,
  type TicketCategory,
} from "@/lib/support-access";

/**
 * The request form.
 *
 * Built around one idea: the person filling this in is usually having a bad
 * time — they can't log in, they were charged twice, they want their money
 * back, something happened that scared them — so every field earns its place
 * and the category is chosen for them whenever the link they arrived on knows
 * the answer. The legal pages link here with ?topic=refund, ?topic=privacy and
 * so on, which is why `initial` exists. Without one, nothing is pre-selected:
 * the person has to pick, because a refund filed under "Something else" sits
 * in the wrong pile with its 48-hour clock running.
 *
 * The success state replaces the form rather than sitting under it, and it
 * leads with the reference and the recorded time. For a refund those two are
 * the requester's proof under app/(legal)/refund-policy, so the confirmation
 * has to read like a receipt, not a thank-you note — and it only says we
 * emailed a copy when the server says the email actually went.
 *
 * Files upload while the person writes (components/support/attachment-picker),
 * into a staging folder of their own; Send waits for any still in flight. The
 * request never fails over a file — the receipt says which ones didn't attach
 * and why. No resetKey: the receipt replaces the form, and the picker with it.
 */
/** One of the person's own charges, as the "which charge?" picker lists it. */
export type PayableOption = {
  id: string;
  kind: "tuition" | "charge" | "demo_day";
  /** "Tuition · $1,500.00 · paid Sep 29, 2026" — built on the server. */
  label: string;
};

export function NewTicketForm({
  initial = null,
  accountEmail,
  context,
  surface = "web",
  payables = [],
  initialPaymentId = null,
}: {
  /** A category the link already knows (?topic=), or null to make them choose. */
  initial?: TicketCategory | null;
  /** Shown read-only, so it's obvious where the reply will go. */
  accountEmail: string;
  /** Prefill context the page already sanitized (?from=, ?source=, ?digest=). */
  context?: { page?: string; source?: string; digest?: string };
  surface?: SupportSurface;
  /** Their charges, for refund and billing requests. Empty: no picker. */
  payables?: PayableOption[];
  /** A charge the link already named (?payment=), checked to be theirs. */
  initialPaymentId?: string | null;
}) {
  const [category, setCategory] = useState<TicketCategory | null>(initial);
  // Which charge it's about. The server checks it's theirs again
  // (createTicket); picking one is what lets the team see the payment — and,
  // for a refund, the 48-hour window — without asking.
  const [paymentId, setPaymentId] = useState(initialPaymentId ?? "");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [receiptRef, setReceiptRef] = useState("");
  const [err, setErr] = useState<string | undefined>();
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [done, setDone] = useState<Extract<SubmitSupportRequestResult, { ok: true }> | null>(
    null,
  );
  // A file still uploading holds Send: a request sent mid-upload goes
  // without the screenshot its author thinks is on it.
  const [uploading, setUploading] = useState(false);
  const [pending, start] = useTransition();
  const doneRef = useRef<HTMLDivElement>(null);

  // The receipt replaces a long form, so bring it into view and to the screen
  // reader's attention rather than leaving the person scrolled past it.
  useEffect(() => {
    if (done) doneRef.current?.focus();
  }, [done]);

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (uploading) return;
    setErr(undefined);
    // The server checks all of this again; checking here just saves the
    // person a round trip to find out they skipped the first question.
    const problems: Record<string, string> = {};
    if (!category) problems.category = "Choose what this is about.";
    if (codePointLength(body.trim()) < TICKET_BODY_MIN) {
      problems.body = "Tell us a bit more — a few sentences about what happened is enough.";
    }
    setFieldErrors(problems);
    if (problems.category) {
      document.querySelector<HTMLInputElement>('input[name="category"]')?.focus();
      return;
    }
    if (problems.body) {
      document.getElementById("support-body")?.focus();
      return;
    }

    const formData = new FormData(e.currentTarget);
    start(async () => {
      try {
        const res = await submitSupportRequest(null, formData);
        if (res.ok) {
          setDone(res);
        } else {
          setErr(res.error);
          setFieldErrors(res.fieldErrors ?? {});
        }
      } catch (e) {
        setErr(getActionError(e));
      }
    });
  }

  if (done) {
    const attached = done.attachments?.recorded ?? 0;
    const missed = done.attachments?.rejected ?? [];
    const them = missed.length === 1 ? "it" : "them";
    return (
      <div
        ref={doneRef}
        tabIndex={-1}
        role="status"
        aria-live="polite"
        className="rounded-xl border border-phosphor/30 bg-phosphor/5 p-6 focus:outline-none"
      >
        <p className="flex items-center gap-2 text-lg font-semibold text-phosphor-ink">
          <CheckCircle2 className="h-5 w-5" />
          We&rsquo;ve got it
        </p>
        <dl className="mt-4 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
          <dt className="font-mono text-[11px] uppercase tracking-wider text-ink-faint">
            Reference
          </dt>
          <dd className="font-mono text-ink">{done.reference}</dd>
          <dt className="font-mono text-[11px] uppercase tracking-wider text-ink-faint">
            Recorded
          </dt>
          <dd className="text-ink">{formatReceivedAt(done.receivedAt)}</dd>
          {attached > 0 && (
            <>
              <dt className="font-mono text-[11px] uppercase tracking-wider text-ink-faint">
                Files
              </dt>
              <dd className="text-ink">{attached} attached</dd>
            </>
          )}
        </dl>
        {/* The request went through either way; a file that didn't is said
            here, by name, with the reason — not left for them to notice. */}
        {missed.length > 0 && (
          <div className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-xs text-amber-700 dark:text-amber-300">
            <p className="font-medium">
              {missed.length === 1 ? "One file" : `${missed.length} files`} didn&rsquo;t
              attach, so your request went without {them}. You can add {them} on
              its page.
            </p>
            <ul className="mt-1 space-y-0.5">
              {missed.map((f, i) => (
                <li key={i} className="break-words">
                  <span className="font-medium">{f.name}</span> — {f.reason}
                </li>
              ))}
            </ul>
          </div>
        )}
        <p className="mt-4 text-sm text-ink-soft">
          {done.emailed ? (
            <>
              We emailed a copy to <strong className="text-ink">{accountEmail}</strong>{" "}
              with a private link to the thread — keep it, and quote the
              reference if you contact us any other way.
            </>
          ) : (
            <>
              We&rsquo;ll email updates to{" "}
              <strong className="text-ink">{accountEmail}</strong>. Quote the
              reference if you contact us any other way.
            </>
          )}
        </p>
        {category === "refund" && (
          <p className="mt-3 text-sm text-ink-soft">
            Because this is a refund request, the recorded time above is the
            time that counts against the 48-hour window in our{" "}
            <Link href="/refund-policy" className="link-ink">
              refund policy
            </Link>
            .
          </p>
        )}
        <div className="mt-5 flex flex-wrap gap-2">
          {/* A plain anchor, not next/link: the thread is the person's own
              request, and nothing about it needs a client-side transition. */}
          <a href={done.threadPath} className={buttonClasses("primary", "md")}>
            Open your request
          </a>
          <ButtonLink
            href={surface === "app" ? "/app/support" : "/dashboard/support"}
            prefetch={false}
            variant="secondary"
          >
            All your requests
          </ButtonLink>
        </div>
      </div>
    );
  }

  const needsReceipt = category !== null && wantsReceiptRef(category);
  const picked = payables.find((p) => p.id === paymentId) ?? null;

  return (
    <form onSubmit={submit} noValidate className="space-y-6">
      <input type="hidden" name="surface" value={surface} />
      {context?.page && <input type="hidden" name="page" value={context.page} />}
      {context?.source && <input type="hidden" name="source" value={context.source} />}
      {context?.digest && <input type="hidden" name="digest" value={context.digest} />}

      <fieldset aria-describedby={fieldErrors.category ? "support-category-error" : undefined}>
        <legend className="mb-3 block text-xs font-mono font-medium uppercase tracking-wider text-ink-soft">
          What&rsquo;s this about
          <span className="sr-only"> required</span>
        </legend>
        <div className="space-y-5">
          {CATEGORY_GROUPS.map((group) => (
            <fieldset key={group.label}>
              <legend className="mb-2 text-[11px] font-mono uppercase tracking-[0.12em] text-ink-faint">
                {group.label}
              </legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {group.categories.map((c) => (
                  <CategoryOption
                    key={c}
                    value={c}
                    checked={category === c}
                    onSelect={() => {
                      setCategory(c);
                      setFieldErrors((prev) => {
                        const next = { ...prev };
                        delete next.category;
                        return next;
                      });
                    }}
                  />
                ))}
              </div>
            </fieldset>
          ))}
        </div>
        <FieldError id="support-category-error">{fieldErrors.category}</FieldError>
      </fieldset>

      {/* What the chosen category needs said up front, before they write. */}
      {category === "concern" && (
        <div
          role="note"
          className="rounded-lg border border-red-500/30 bg-red-500/[0.06] px-4 py-3 text-sm text-ink"
        >
          <p className="flex items-start gap-2 font-medium">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-red-700 dark:text-red-300" />
            <span>
              If anyone is in immediate danger, call 911. If you or someone you
              know is struggling, call or text 988.
            </span>
          </p>
          <p className="mt-2 pl-6 text-xs leading-relaxed text-ink-soft">
            Reports here are confidential: only a small number of senior staff
            can read them, and the reply comes to you directly.
          </p>
        </div>
      )}
      {category === "refund" && (
        <p className="rounded-lg border border-line bg-wash px-3 py-2.5 text-xs leading-relaxed text-ink-soft">
          Tuition can be refunded within 48 hours of paying, and the time we
          record this request is the time that counts — it stops the clock.
          Demo Day tickets are final sale unless batch0 cancels Demo Day. The
          details are in our{" "}
          <Link href="/refund-policy" className="link-ink">
            refund policy
          </Link>
          .
        </p>
      )}
      {category === "program" && (
        <p className="rounded-lg border border-line bg-wash px-3 py-2.5 text-xs leading-relaxed text-ink-soft">
          A question about lesson content gets a faster answer in{" "}
          <Link href="/dashboard/discussions" prefetch={false} className="link-ink">
            Discussions
          </Link>
          , where mentors and your cohort can jump in. This form is for
          schedules, assignments, your team, your mentor and Demo Day logistics.
        </p>
      )}

      <div>
        <Label htmlFor="support-subject">
          Subject{" "}
          <span className="normal-case tracking-normal text-ink-faint">(optional)</span>
        </Label>
        <Input
          id="support-subject"
          name="subject"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          placeholder={
            category === "refund"
              ? "Refund request — tuition paid September 29"
              : "One line on what you need"
          }
          maxLength={TICKET_SUBJECT_MAX}
          autoComplete="off"
          error={fieldErrors.subject}
        />
        <FieldError id="support-subject-error">{fieldErrors.subject}</FieldError>
        <p className="mt-1.5 text-xs text-ink-faint">
          Leave it blank and we&rsquo;ll use the first line of your message.
        </p>
      </div>

      {needsReceipt && payables.length > 0 && (
        <div>
          <Label htmlFor="support-payment">
            Which charge is this about{" "}
            <span className="normal-case tracking-normal text-ink-faint">(optional)</span>
          </Label>
          <Select
            id="support-payment"
            name="payment_id"
            value={paymentId}
            onChange={(e) => setPaymentId(e.target.value)}
          >
            <option value="">Not sure, or it isn&rsquo;t listed</option>
            {payables.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </Select>
          {category === "refund" && picked?.kind === "demo_day" && (
            <p className="mt-1.5 text-xs text-amber-700 dark:text-amber-300">
              Demo Day tickets are final sale unless batch0 cancels Demo Day
              — but if something went wrong with yours, tell us below.
            </p>
          )}
        </div>
      )}

      {needsReceipt && !picked && (
        <div>
          <Label htmlFor="support-receipt">Receipt or transaction ID</Label>
          <Input
            id="support-receipt"
            name="receipt_ref"
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
            <Link href="/dashboard/billing/receipts" prefetch={false} className="link-ink">
              Billing → Receipts
            </Link>
            .
          </p>
        </div>
      )}

      <div>
        <Label htmlFor="support-body" required>
          What happened
        </Label>
        <Textarea
          id="support-body"
          name="body"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={7}
          maxLength={TICKET_BODY_MAX}
          error={fieldErrors.body}
          placeholder={
            category === "refund"
              ? "When you paid, what you paid for, and that you'd like it refunded. You don't have to explain why — we don't ask."
              : category === "concern"
                ? "What happened, who was involved, and when — as much or as little as you're comfortable sharing."
                : "The more specific the better. What you expected, what happened instead, and anything you've already tried."
          }
        />
        <FieldError id="support-body-error">{fieldErrors.body}</FieldError>
        <p className="mt-1.5 text-xs text-ink-faint">
          Don&rsquo;t include card numbers or passwords — we never need them.
        </p>
      </div>

      <fieldset>
        <legend className="mb-1.5 block text-xs font-mono font-medium uppercase tracking-wider text-ink-soft">
          Attachments{" "}
          <span className="normal-case tracking-normal text-ink-faint">(optional)</span>
        </legend>
        <AttachmentPicker scope={{ kind: "new" }} onBusyChange={setUploading} disabled={pending} />
      </fieldset>

      <div className="rounded-lg border border-line bg-wash px-3 py-2.5 text-xs text-ink-soft">
        We&rsquo;ll reply to <strong className="text-ink">{accountEmail}</strong>
        , the address on your account.
      </div>

      {/* Field problems are shown on their fields; this is for everything else
          (rate limits, an account without a usable address, a failed send). */}
      {err && Object.keys(fieldErrors).length === 0 && (
        <p role="alert" className="text-sm text-red-700 dark:text-red-300">
          {err}
        </p>
      )}

      <Button
        type="submit"
        size="lg"
        className="w-full sm:w-auto"
        disabled={pending || uploading}
        aria-busy={pending}
      >
        {pending ? "Sending…" : uploading ? "Waiting for files…" : "Send request"}
      </Button>
    </form>
  );
}

/**
 * One category, as a radio card. A real radio input rather than a button with
 * role="radio": with eleven options the arrow keys, the form value and the
 * screen-reader announcement all have to work, and the native control gives
 * all three for free.
 */
function CategoryOption({
  value,
  checked,
  onSelect,
}: {
  value: TicketCategory;
  checked: boolean;
  onSelect: () => void;
}) {
  return (
    <label
      className={`press flex cursor-pointer items-start gap-3 rounded-md border p-3.5 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-phosphor/40 ${
        checked ? "border-ink bg-wash" : "border-line bg-paper hover:border-ink/30"
      }`}
    >
      <input
        type="radio"
        name="category"
        value={value}
        checked={checked}
        onChange={onSelect}
        className="mt-0.5 h-4 w-4 shrink-0 accent-phosphor focus:outline-none"
      />
      <span>
        <span className="block text-sm font-medium text-ink">{CATEGORY_LABELS[value]}</span>
        <span className="mt-0.5 block text-xs leading-relaxed text-ink-soft">
          {CATEGORY_HINTS[value]}
        </span>
      </span>
    </label>
  );
}
