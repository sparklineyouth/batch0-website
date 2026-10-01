import { isPlaceholderEmail } from "@/lib/placeholder-email";
import { parseCategory, sanitizeContext } from "@/lib/support-access";
import { NewTicketForm } from "@/components/support/new-ticket-form";

/**
 * The signed-in half of both request pages — /support (marketing chrome) and
 * /dashboard/support/new (the dashboard's) — so the two can't drift on what a
 * link may prefill, or on who gets a form at all.
 *
 * Server-safe and free of lib/support.ts: the prefill is cleaned with the pure
 * sanitizer, and nothing here needs the database.
 */

/** What a link into the form may carry. Values arrive as arrays when repeated. */
export type SupportPrefillParams = {
  topic?: string | string[];
  from?: string | string[];
  source?: string | string[];
  digest?: string | string[];
};

/**
 * The same params, cleaned, as a query string ("" when nothing survives) —
 * for carrying them through /login. A topic that isn't a category is dropped
 * rather than turned into "other", so the form still asks.
 */
export function prefillQuery(params: SupportPrefillParams): string {
  const clean = sanitizeContext({ page: params.from, source: params.source, digest: params.digest });
  const q = new URLSearchParams();
  const topic = parseCategory(params.topic);
  if (topic) q.set("topic", topic);
  if (clean.page) q.set("from", clean.page);
  if (clean.source) q.set("source", clean.source);
  if (clean.digest) q.set("digest", clean.digest);
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
}: {
  email: string;
  params: SupportPrefillParams;
  contactEmail: string;
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
  return (
    <NewTicketForm
      // parseCategory, not toCategory: only a real category preselects. A
      // mistyped ?topic= leaves the choice to the person instead of quietly
      // filing it under "Something else".
      initial={parseCategory(params.topic)}
      accountEmail={email.trim()}
      context={{ page: clean.page, source: clean.source, digest: clean.digest }}
    />
  );
}
