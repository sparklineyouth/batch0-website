/**
 * Pure campaign arithmetic and copy, shared by the composer (which quotes) and
 * the action (which spends).
 *
 * It exists for the same reason app/admin/email/blast/shared.ts does: a count
 * the button computes one way and the server computes another is a button that
 * lies. Here the lie is worse than "you mailed 12 families, not 40" — SMS bills
 * per segment per recipient, so a composer whose arithmetic disagrees with the
 * sender under-quotes the invoice, and the quote's entire job is to make someone
 * hesitate before spending.
 *
 * No imports, deliberately, exactly like lib/sms/segments.ts: this module loads
 * in the browser bundle to drive the live estimate AND in the server action that
 * inserts the campaign row. An `import type` would be erased, but the rule kept
 * literally is the rule that survives someone later adding a value import to the
 * same line.
 */

/**
 * What one segment costs us, in cents.
 *
 * docs/sms.md's costing (checked September 2026): Twilio's US toll-free base
 * rate of about $0.0083 a segment plus a blended carrier surcharge of about
 * $0.003, so roughly 1.13¢ — and it moves without asking us. Rounded UP to a
 * flat 1.2¢ on purpose: the only error that matters in an estimate whose job
 * is to cause hesitation is the one that comes in under the invoice.
 */
export const SEGMENT_COST_CENTS = 1.2;

/**
 * Cents this campaign will cost — segments per message × people × rate.
 *
 * Multiplicative, which is the thing operators consistently underestimate: one
 * pasted emoji takes a 1-segment message to 3, and at 300 recipients that is not
 * a rounding error, it is triple the bill for a character nobody chose.
 */
export function estimateCost(segments: number, recipients: number): number {
  const s = Math.max(1, Math.ceil(segments || 0));
  const n = Math.max(0, Math.floor(recipients || 0));
  return s * n * SEGMENT_COST_CENTS;
}

/** "$3.15". Always two decimals — "$3.2" reads like a truncation. */
export function formatCost(cents: number): string {
  return `$${(Math.max(0, cents) / 100).toFixed(2)}`;
}

/** "34 students" / "1 student" — the recipients, counted, for a confirm dialog. */
export function describeRecipients(count: number): string {
  return count === 1 ? "1 student" : `${count} students`;
}

/**
 * The headline an operator actually needs:
 *
 *   "31 of 34 people can't be texted: 28 no number on file, 3 hasn't opted in."
 *
 * A composer that reports only the reachable count is worse than one that
 * reports nothing, because it hides the number that is wrong and the work that
 * would fix it. Returns null when everybody is reachable — there is no sentence
 * worth printing for zero.
 *
 * Generic over the reason key rather than naming the `UnreachableReason` union,
 * because that union (and its wording) lives in lib/sms/audience.ts next to the
 * code that assigns it — a module this one must not import. Tying `counts` and
 * `labels` to the same `K` is not decoration: it makes passing a count map and a
 * label map that describe different vocabularies a compile error.
 */
export function describeUnreachable<K extends string>(
  reachable: number,
  counts: Record<K, number>,
  labels: Record<K, string>,
): string | null {
  const entries = Object.entries(counts) as [K, number][];
  const blocked = entries.reduce((a, [, n]) => a + (n || 0), 0);
  if (blocked <= 0) return null;
  const total = reachable + blocked;
  const parts = entries
    .filter(([, n]) => n > 0)
    // Biggest cause first: it is the one worth doing something about.
    .sort((a, b) => b[1] - a[1])
    .map(([reason, n]) => `${n} ${labels[reason] ?? reason}`);
  return `${blocked} of ${total} ${
    total === 1 ? "person" : "people"
  } can't be texted: ${parts.join(", ")}.`;
}

/** "9:00–20:00" for the quiet-hours line. Recipient-local, always. */
export function formatQuietWindow(startHour: number, endHour: number): string {
  const h = (n: number) => `${String(n).padStart(2, "0")}:00`;
  return `${h(startHour)}–${h(endHour)}`;
}
