// ---------------------------------------------------------------------------
// Every sentence texting puts in front of a person: the opt-in disclosures,
// the automatic replies to STOP, START, HELP and everything else, and the rule
// for when the first-message disclosure is appended.
//
// Import-free, so lib/sms-policy.test.ts can load it and hold each sentence to
// what the privacy policy promises (program texts only, STOP named, rates and
// frequency stated, never a condition) — and to one GSM-7 segment for the
// replies, which go out on every keyword and are billed like any other text.
// The campaign composer (a client component) imports the disclosure rule from
// here too. lib/sms/consent.ts re-exports the sentences.
// ---------------------------------------------------------------------------

// The opt-in disclosures. Each string is the legal artifact. The rendered text is snapshotted into
// messaging_consent_log.consent_text on every grant, so editing it here does NOT
// rewrite history — past consent keeps the words it was given under, which is
// the entire point of storing the text rather than a version number.
//
// Every element is required by something. Brand name, what the messages are,
// "Msg & data rates may apply", message frequency, the STOP instruction, and
// that it is not a condition of anything are what a carrier's vetting team
// looks for in the opt-in screenshot; the checkbox being unchecked by default
// and separate from any other agreement is what makes it a deliberate choice
// rather than a bundled term. And it repeats the privacy policy's promise in
// the person's own first person, so the box they tick can't be read as wider
// than the policy beside it.

export const CONSENT_COPY = {
  /** Shown to a student, next to their own number, on /dashboard/phone. */
  studentTransactional:
    "Text me program updates from batch0 (Sparkline Youth LLC) at this number — " +
    "things like a session starting, a schedule change, or a deadline. No " +
    "marketing texts. Message frequency varies. Msg & data rates may apply. " +
    "Reply STOP to opt out or HELP for help. Agreeing is not a condition of " +
    "applying or enrolling.",

  /**
   * Ticked by an admin in the campaign composer, for their own phone, so a
   * test send can actually reach a handset. Without it there is no way to
   * test on a real phone at all: the only other opt-in is /dashboard/phone,
   * which needs an application, and staff don't have one.
   */
  adminTest:
    "This is my own mobile number, and I agree to receive test texts from " +
    "batch0 (Sparkline Youth LLC) at it. Msg & data rates may apply. Reply " +
    "STOP to opt out.",
} as const;

/** What a STOP reply is answered with. Must confirm and must not re-market. */
export const OPT_OUT_REPLY =
  "batch0: You're unsubscribed and won't get any more texts from us. " +
  "Reply START to resubscribe. Email hello@batch0.org for help.";

/**
 * The public texting page: what HELP replies, the footer, the legal pages and
 * the toll-free verification form all point at.
 *
 * Not /messages. That path belongs to Chat: next.config.js redirects it to
 * /chat for old "messaged you" bells, and a config redirect wins over any page,
 * so a texting page there would be unreachable (lib/sms-policy.test.ts checks
 * no redirect matches this one).
 */
export const TEXTS_PAGE_PATH = "/texts";

/** What a HELP reply is answered with. Brand + contact + opt-out, nothing else. */
export const HELP_REPLY =
  "batch0 (Sparkline Youth LLC) program updates. Msg & data rates may apply. " +
  `Reply STOP to opt out. Help: hello@batch0.org or batch0.org${TEXTS_PAGE_PATH}`;

/** What a START reply is answered with. */
export const OPT_IN_REPLY =
  "batch0: You're resubscribed to program updates. Reply STOP to opt out. " +
  "Msg & data rates may apply.";

/** The reply to anything that isn't a keyword or a request to stop. */
export const UNMONITORED_REPLY =
  "batch0: This number only sends program updates and isn't monitored. " +
  "Please email hello@batch0.org and we'll get back to you. Reply STOP to opt out.";

// ---------------------------------------------------------------------------
// The first-message disclosure
//
// CTIA expects three things in the first text a number gets from us: the brand,
// how to opt out, and that message and data rates may apply. The transport
// appends the settings row's help text to that first message (lib/sms/send.ts
// and the drain both call this), and the composer calls it too so its segment
// count is the one we'll be billed for.
//
// It is skipped only when the body already carries all three. This used to be
// skipped whenever the body contained "STOP" — so "Kickoff moved to 5pm. Text
// STOP to opt out." went to a brand-new number with no brand and no rates
// notice, and so did "Don't STOP building!".
// ---------------------------------------------------------------------------

/** Does `body` already say who we are, how to stop, and that rates may apply? */
export function carriesFirstMessageDisclosure(body: string, helpText: string): boolean {
  if (helpText && body.includes(helpText)) return true;
  return (
    /\bbatch0\b|sparkline youth/i.test(body) &&
    /\bSTOP\b/.test(body) &&
    /rates\s+may\s+apply/i.test(body)
  );
}

/** The body as it goes on the wire: with the disclosure on a number's first text. */
export function withFirstMessageDisclosure(body: string, helpText: string, first: boolean): string {
  if (!first || carriesFirstMessageDisclosure(body, helpText)) return body;
  return `${body}\n\n${helpText}`;
}
