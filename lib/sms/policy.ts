// ---------------------------------------------------------------------------
// What texting is allowed to do, in one place.
//
// The privacy policy promises "We do not send promotional or marketing texts"
// (app/(legal)/privacy, locked by lib/sms-consent-policy.test.ts), and
// docs/sms-marketing-opt-in.md lists what would have to exist before that could
// change: a separate opt-in, guardian confirmation for under-18s, a re-consent
// campaign, a lawyer's read. None of that is built. So the texting feature
// ships with marketing switched off at every layer that could produce it — the
// consent writer, the consent gate in the transport, and the campaign composer
// — and all three read the switch from here so they cannot disagree.
//
// Import-free on purpose, like lib/sms/segments.ts: the composer (a client
// component) and the test runner both load it, and neither can resolve the
// "@/…" alias the server modules use.
//
// If you are here to turn MARKETING_TEXTS_ENABLED on: lib/sms-policy.test.ts
// will fail, and the fix is not to edit the assertion. It is the list in
// docs/sms-marketing-opt-in.md, then the privacy policy, then this line.
// ---------------------------------------------------------------------------

/** Off. See the header — this is a policy decision, not a feature flag. */
export const MARKETING_TEXTS_ENABLED = false as const;

export type SmsPurpose = "transactional" | "promotional";

/** May anything in the app record consent for, queue, or send `purpose`? */
export function isPurposeAllowed(purpose: string): purpose is SmsPurpose {
  if (purpose === "transactional") return true;
  if (purpose === "promotional") return MARKETING_TEXTS_ENABLED;
  return false;
}

/** The refusal every layer gives for a purpose the policy doesn't allow. */
export const PURPOSE_REFUSED =
  "batch0 only sends program texts. Promotional texts are off by policy — see docs/sms-marketing-opt-in.md.";

/**
 * The youngest applicant who may opt in to texts.
 *
 * The application form accepts an age of 10 (app/apply/actions.ts), and
 * docs/sms-marketing-opt-in.md flags that under 13 a phone number is personal
 * information COPPA says needs *verifiable* parental consent, which a box the
 * child ticks is not. Until a real verifiable-consent flow exists, an under-13
 * applicant simply isn't offered texts: the program reaches them by email, and
 * through the parent email we already require for anyone under 18.
 */
export const SMS_MIN_AGE = 13;

/**
 * May an applicant of this age opt their own number in?
 *
 * An unknown age is allowed: every application since the form asked has an age
 * (it is required and validated server-side), so `null` means a row that
 * predates the question — an older, already-admitted student — not a child
 * hiding their age.
 */
export function canOptInAtAge(age: number | null | undefined): boolean {
  if (age === null || age === undefined || !Number.isFinite(age)) return true;
  return age >= SMS_MIN_AGE;
}

/**
 * The audiences a program text may go to, by email-catalog segment value.
 *
 * Narrower than the email composer's list on purpose. A program text is about
 * an application someone made or a cohort they are in — "everyone with an
 * account", drafts, mentors and admins aren't on that list, and texting them
 * "program logistics" would stretch the consent they gave past what it says.
 */
export const SMS_AUDIENCE_SEGMENTS = ["enrolled", "accepted", "waitlisted", "applied"] as const;

export type SmsAudienceSegment = (typeof SMS_AUDIENCE_SEGMENTS)[number];

export function isSmsAudienceSegment(v: string): v is SmsAudienceSegment {
  return (SMS_AUDIENCE_SEGMENTS as readonly string[]).includes(v);
}

/**
 * The defaults the settings row starts with, mirrored from 0106's column
 * defaults so an absent or unreadable row and a freshly seeded one describe
 * the same window. lib/sms-policy.test.ts reads the migration to keep the two
 * in step.
 */
export const DEFAULT_QUIET_HOURS = { startHour: 9, endHour: 20 } as const;

export const DEFAULT_HELP_TEXT =
  "batch0: Reply STOP to opt out, HELP for help. Msg&data rates may apply.";
