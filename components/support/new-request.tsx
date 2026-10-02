import { isPlaceholderEmail } from "@/lib/placeholder-email";
import type { OwnPayable } from "@/lib/support";
import { isUuid, parseCategory, sanitizeContext } from "@/lib/support-access";
import {
  NewTicketForm,
  type PayableOption,
} from "@/components/support/new-ticket-form";

/**
 * The signed-in half of both request pages — /support (marketing chrome) and
 * /dashboard/support/new (the dashboard's) — so the two can't drift on what a
 * link may prefill, or on who gets a form at all.
 *
 * Server-safe and free of lib/support.ts at runtime (the import above is
 * types only): the prefill is cleaned with the pure sanitizer, and the pages
 * do the one database read — the person's own charges — and pass it in.
 */

/** What a link into the form may carry. Values arrive as arrays when repeated. */
export type SupportPrefillParams = {
  topic?: string | string[];
  from?: string | string[];
  source?: string | string[];
  digest?: string | string[];
  /** One of the person's own charges (billing's "Problem with this charge?"). */
  payment?: string | string[];
};

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Charges worth asking about, as the "which charge?" picker lists them. A
 * checkout that never completed (pending or failed tuition) and a cancelled
 * fee are left out: they're not money anyone has been asked for or taken.
 * Labels are built here, on the server, in one fixed zone, so the server's
 * and the browser's render can't disagree about a date.
 */
export function payableOptions(payables: OwnPayable[]): PayableOption[] {
  const money = (cents: number, currency: string) =>
    new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase() }).format(
      cents / 100,
    );
  const day = (iso: string) =>
    new Date(iso).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      timeZone: "America/New_York",
    });
  return payables
    .filter((p) =>
      p.kind === "tuition"
        ? p.status !== "pending" && p.status !== "failed"
        : p.kind === "charge"
          ? p.status !== "cancelled"
          : true,
    )
    .map((p) => {
      const state =
        p.status === "refunded"
          ? "refunded"
          : p.status === "pending"
            ? "not paid yet"
            : p.status === "waived"
              ? "waived"
              : p.paidAt
                ? `paid ${day(p.paidAt)}`
                : `from ${day(p.createdAt)}`;
      return {
        id: p.id,
        kind: p.kind,
        label: `${p.description} · ${money(p.amountCents, p.currency)} · ${state}`,
      };
    });
}

/**
 * The same params, cleaned, as a query string ("" when nothing survives) —
 * for carrying them through /login. A topic that isn't a category is dropped
 * rather than turned into "other", so the form still asks.
 */
export function prefillQuery(params: SupportPrefillParams): string {
  const clean = sanitizeContext({ page: params.from, source: params.source, digest: params.digest });
  const q = new URLSearchParams();
  const topic = parseCategory(params.topic);
  const payment = first(params.payment);
  if (topic) q.set("topic", topic);
  if (clean.page) q.set("from", clean.page);
  if (clean.source) q.set("source", clean.source);
  if (clean.digest) q.set("digest", clean.digest);
  // Only an id-shaped value survives the trip through /login; whether it's
  // theirs is decided once they're signed in (it must be among their charges).
  if (isUuid(payment)) q.set("payment", payment);
  const s = q.toString();
  return s ? `?${s}` : "";
}

/**
 * Accounts an admin created without an email carry a placeholder on the
 * reserved .invalid TLD (lib/placeholder-email.ts). We could never reply to
 * one, so they get the address to write to instead of a form that would only
 * refuse them at the end.
 */
function canReplyTo(email: string): boolean {
  const e = email.trim();
  return !!e && !isPlaceholderEmail(e) && !/\.invalid$/i.test(e);
}

export function NewRequest({
  email,
  params,
  contactEmail,
  payables = [],
}: {
  email: string;
  params: SupportPrefillParams;
  contactEmail: string;
  /** The person's own charges (listOwnPayables), for the "which charge?" picker. */
  payables?: OwnPayable[];
}) {
  if (!canReplyTo(email)) {
    return (
      <div className="rounded-xl border border-line bg-wash p-6">
        <h2 className="text-lg font-semibold text-ink">Email us instead</h2>
        <p className="mt-2 text-sm leading-relaxed text-ink-soft">
          Your account doesn&rsquo;t have an email address we can reply to, so
          this form can&rsquo;t take your request. Email{" "}
          <a href={`mailto:${contactEmail}`} className="link-ink">
            {contactEmail}
          </a>{" "}
          instead — it reaches the same people and counts the same, refunds
          included.
        </p>
      </div>
    );
  }

  const clean = sanitizeContext({ page: params.from, source: params.source, digest: params.digest });
  const options = payableOptions(payables);
  // A ?payment= preselects only one of their own charges; anything else —
  // someone else's id, a stale link — is simply no preselection.
  const payment = first(params.payment);
  const initialPayment = options.some((o) => o.id === payment) ? payment! : null;
  return (
    <NewTicketForm
      // parseCategory, not toCategory: only a real category preselects. A
      // mistyped ?topic= leaves the choice to the person instead of quietly
      // filing it under "Something else".
      initial={parseCategory(params.topic)}
      accountEmail={email.trim()}
      context={{ page: clean.page, source: clean.source, digest: clean.digest }}
      payables={options}
      initialPaymentId={initialPayment}
    />
  );
}
