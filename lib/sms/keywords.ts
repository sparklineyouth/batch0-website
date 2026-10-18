// ---------------------------------------------------------------------------
// Inbound keyword classification.
//
// Split out of lib/sms/consent.ts and deliberately IMPORT-FREE, for the same
// reason lib/sms/segments.ts is: consent.ts reaches its collaborators through
// the "@/…" alias, which is a tsconfig/bundler concept that `node --test`
// cannot resolve. A module with no imports can be tested directly, and the
// alternative — a test that duplicates the keyword table — would be a test of a
// copy, which for an opt-out classifier is worse than no test at all.
//
// This is the function that decides whether an inbound text is a withdrawal of
// consent. Being wrong in either direction is a real harm: a missed STOP is a
// revocation we failed to honour inside the ten-business-day window the FCC's
// revocation rule opened on April 11, 2025, and a false positive unsubscribes
// someone who asked a question and then wonders why we went silent.
// ---------------------------------------------------------------------------

/**
 * The CTIA-mandated set, plus the variants people actually send.
 *
 * Matching is on the whole trimmed body, case- and punctuation-insensitive,
 * because "STOP." and "stop!" are unambiguous opt-outs and treating them as
 * unrecognised is exactly what the revocation rule exists to punish.
 */
const STOP_WORDS = new Set([
  "stop",
  "stopall",
  "stop all",
  "unsubscribe",
  "cancel",
  "end",
  "quit",
  "optout",
  "opt out",
  "remove",
  // Named explicitly in the FCC's April 2025 revocation rule as a word that must
  // be honoured. Omitting it was a real gap: someone texting "revoke" is making
  // the clearest possible statement and would have been classified as chatter.
  "revoke",
  "revoke consent",
]);
const START_WORDS = new Set(["start", "unstop", "yes", "optin", "opt in", "subscribe"]);
const HELP_WORDS = new Set(["help", "info"]);

export type InboundIntent = "stop" | "start" | "help" | "other";

/**
 * Classify an inbound message body.
 *
 * Deliberately NOT a substring match. "Can you stop by on Thursday?" is not an
 * opt-out, and unsubscribing someone who asked a question is its own harm — so
 * the comparison is against the entire normalized body, and anything else falls
 * through to "other".
 */
export function classifyInbound(body: string): InboundIntent {
  const normalized = normalizeBody(body);
  if (STOP_WORDS.has(normalized)) return "stop";
  if (START_WORDS.has(normalized)) return "start";
  if (HELP_WORDS.has(normalized)) return "help";
  return "other";
}

function normalizeBody(body: string): string {
  return (
    body
      .trim()
      .toLowerCase()
      // Curly apostrophes become straight ones first, so "don’t text me" (what a
      // phone keyboard sends) and "don't text me" are the same sentence.
      .replace(/[\u2018\u2019]/g, "'")
      // Strip sentence punctuation: "STOP." and "stop!" are unambiguous.
      .replace(/[.!?,;:'"]+/g, "")
      // Hyphens, underscores and dashes become spaces BEFORE whitespace
      // collapses, so "opt-out", "opt—out" and "stop_all" land on the same table
      // entries as their spaced spellings. Without this, "opt out" and "optout"
      // were both honoured while the hyphenated form people actually type was
      // not.
      .replace(/[-_\u2010-\u2015]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

// ---------------------------------------------------------------------------
// Revocation in a sentence
//
// classifyInbound is deliberately exact: it decides what the automated STOP /
// START / HELP replies say, and a substring match there would answer "can you
// stop by on Thursday?" with an unsubscribe confirmation. But the FCC rule that
// took effect April 11, 2025 (47 CFR 64.1200(a)(10)) does not let us stop
// there. A reply in other words has to be treated as a revocation when a
// reasonable person would read it as one — and the privacy policy promises the
// same thing ("tell us any other reasonable way"). Nobody reads this number, so
// "please stop texting me" answered with "this number isn't monitored, email
// us" would be a revocation we were told about and didn't honour.
//
// So the webhook asks this second question of everything classifyInbound calls
// "other". It errs towards revoking, because the two mistakes are not the same
// size: a false positive costs someone the logistics texts they still get by
// email, and the confirmation tells them START undoes it; a false negative is a
// text sent after someone asked us to stop.
// ---------------------------------------------------------------------------

/**
 * Phrases that ask us to stop, matched anywhere in the normalized body.
 *
 * Each is specific enough that its presence decides the question on its own:
 * "stop texting", not "stop". "wrong number" is here because it is the clearest
 * revocation a recycled number can send — the person who agreed is gone.
 */
const REVOCATION_PHRASES = [
  "stop texting",
  "stop messaging",
  "stop sending",
  "stop contacting",
  "stop txting",
  "quit texting",
  "quit messaging",
  "no more texts",
  "no more text messages",
  "no more messages",
  "dont text",
  "do not text",
  "dont message",
  "do not message",
  "dont contact",
  "do not contact",
  "remove me",
  "remove my number",
  "take me off",
  "take my number off",
  "unsubscribe",
  "opt out",
  "optout",
  "opt me out",
  "revoke",
  "wrong number",
  "leave me alone",
];

/**
 * Words that carry no meaning of their own in a short reply. A body made of
 * one STOP keyword plus only these — "please stop", "STOP NOW", "stop it
 * thanks" — is the keyword said politely, not a sentence about something else.
 */
const FILLER = new Set([
  "please",
  "pls",
  "plz",
  "now",
  "thanks",
  "thank",
  "you",
  "ty",
  "it",
  "ok",
  "okay",
  "just",
  "all",
  "these",
  "this",
  "texts",
  "text",
  "messages",
  "me",
  "us",
  "sir",
  "and",
]);

/**
 * Does this message, which is not an exact keyword, ask us to stop?
 *
 * True for an exact STOP keyword too, so a caller can ask it alone.
 */
export function expressesRevocation(body: string): boolean {
  const normalized = normalizeBody(body);
  if (!normalized) return false;
  if (STOP_WORDS.has(normalized)) return true;

  // "dont" — normalizeBody strips the apostrophe, so "don't" arrives as "dont".
  const padded = ` ${normalized} `;
  if (REVOCATION_PHRASES.some((p) => padded.includes(` ${p} `))) return true;

  const words = normalized.split(" ");
  const meaningful = words.filter((w) => !FILLER.has(w));
  return meaningful.length > 0 && meaningful.every((w) => STOP_WORDS.has(w));
}

/**
 * Is this inbound text an opt-out — the STOP keyword, or a sentence asking us
 * to stop?
 *
 * The one definition both the webhook and the drain's reconcile pass use, so a
 * revocation the webhook couldn't record is recognised by the same rule when
 * the drain finds it in the inbound log. A START, HELP or INFO is never one,
 * even though expressesRevocation alone would not be asked about them.
 */
export function isOptOutRequest(body: string): boolean {
  const intent = classifyInbound(body);
  return intent === "stop" || (intent === "other" && expressesRevocation(body));
}
