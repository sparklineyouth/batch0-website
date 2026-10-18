// ---------------------------------------------------------------------------
// Segment counting — what a text actually costs.
//
// SMS does not bill per message, it bills per 160-character segment, and the
// 160 collapses to 70 the instant one character falls outside the GSM 03.38
// alphabet. A single emoji in a 140-character message turns one segment into
// three. That is a 3x invoice for a character nobody deliberately added, so the
// composer counts before it sends rather than discovering it on a bill.
//
// No dependency and no imports on purpose, same as lib/email/vars.ts: this runs
// in the browser to drive the live counter in the composer AND on the server to
// stamp `sms_outbox.segments`, and the two must agree exactly or the preview
// lies about the price.
// ---------------------------------------------------------------------------

/**
 * GSM 03.38 basic character set.
 *
 * Written out rather than expressed as ranges because it genuinely is an
 * arbitrary set — it interleaves Latin letters with Greek capitals that happen
 * to be visually distinct, and skips the ones that don't (no Alpha, because it
 * looks like A). Getting this wrong in either direction is expensive: a
 * character wrongly included under-counts the segments and the send costs more
 * than quoted; wrongly excluded and every message reports as UCS-2.
 */
const GSM7_BASIC = new Set(
  [
    "@£$¥èéùìòÇ\nØø\rÅå",
    "Δ_ΦΓΛΩΠΨΣΘΞ",
    "ÆæßÉ",
    " !\"#¤%&'()*+,-./",
    "0123456789:;<=>?",
    "¡ABCDEFGHIJKLMNO",
    "PQRSTUVWXYZÄÖÑÜ§",
    "¿abcdefghijklmno",
    "pqrstuvwxyzäöñüà",
  ]
    .join("")
    .split(""),
);

/**
 * The extension table. Each of these is legal in a GSM-7 message but occupies
 * TWO septets, because it is encoded as an escape byte followed by the
 * character. A message of 160 newlines fits; a message of 160 left braces does
 * not.
 */
const GSM7_EXTENDED = new Set(["\f", "^", "{", "}", "\\", "[", "~", "]", "|", "€"]);

/** Single-segment and multi-segment capacities, per encoding. */
const GSM7_SINGLE = 160;
const GSM7_MULTI = 153; // 7 septets go to the concatenation header
const UCS2_SINGLE = 70;
const UCS2_MULTI = 67; // 3 code units go to the header

export type SmsEncoding = "GSM-7" | "UCS-2";

export type SegmentInfo = {
  encoding: SmsEncoding;
  /** Billable segments. Always at least 1, even for an empty body. */
  segments: number;
  /** Encoding-weighted length — what is actually measured against capacity. */
  units: number;
  /** Capacity of the current segmentation, for "N characters left". */
  capacity: number;
  /**
   * The characters that forced UCS-2, deduped and in first-appearance order.
   * Surfaced in the composer so "why is this 3 segments?" has an answer the
   * author can act on — usually by deleting one curly quote.
   */
  nonGsmChars: string[];
};

/**
 * Measure `body` the way a carrier will.
 *
 * Iterates by code POINT, not code unit, so an emoji is seen as one character
 * that costs two UCS-2 units rather than as two broken halves. `for...of` over a
 * string does this correctly; `.length` and indexed access do not.
 */
export function measureSms(body: string): SegmentInfo {
  let gsmUnits = 0;
  let ucs2Units = 0;
  let gsmSafe = true;
  const nonGsm: string[] = [];
  const seen = new Set<string>();

  for (const ch of body) {
    // UCS-2 cost: anything outside the Basic Multilingual Plane is a surrogate
    // pair and bills as two units. Every emoji lands here.
    ucs2Units += ch.codePointAt(0)! > 0xffff ? 2 : 1;

    if (GSM7_BASIC.has(ch)) {
      gsmUnits += 1;
    } else if (GSM7_EXTENDED.has(ch)) {
      gsmUnits += 2;
    } else {
      gsmSafe = false;
      if (!seen.has(ch)) {
        seen.add(ch);
        nonGsm.push(ch);
      }
    }
  }

  const encoding: SmsEncoding = gsmSafe ? "GSM-7" : "UCS-2";
  const units = gsmSafe ? gsmUnits : ucs2Units;
  const single = gsmSafe ? GSM7_SINGLE : UCS2_SINGLE;
  const multi = gsmSafe ? GSM7_MULTI : UCS2_MULTI;

  if (units === 0) {
    return { encoding, segments: 1, units: 0, capacity: single, nonGsmChars: [] };
  }
  if (units <= single) {
    return { encoding, segments: 1, units, capacity: single, nonGsmChars: nonGsm };
  }
  return {
    encoding,
    segments: Math.ceil(units / multi),
    units,
    capacity: multi,
    nonGsmChars: nonGsm,
  };
}

/** Just the billable count, for stamping a row. */
export function countSegments(body: string): number {
  return measureSms(body).segments;
}

/**
 * The common offenders, and what to replace them with.
 *
 * Every one of these arrives by autocorrect or by pasting out of Google Docs,
 * which is exactly how campaign copy gets written. Offering the swap turns a
 * 3x cost into a one-click fix instead of a lecture about character sets.
 */
export const GSM_SUBSTITUTIONS: ReadonlyArray<readonly [string, string]> = [
  ["‘", "'"], // ' left single quote
  ["’", "'"], // ' right single quote / apostrophe
  ["“", '"'], // " left double quote
  ["”", '"'], // " right double quote
  ["–", "-"], // – en dash
  ["—", "-"], // — em dash
  ["…", "..."], // … ellipsis
  [" ", " "], // non-breaking space
  ["•", "*"], // • bullet
  ["′", "'"], // ′ prime
  ["´", "'"], // ´ acute accent used as apostrophe
];

/**
 * Replace the typographic characters that force UCS-2 with their ASCII twins.
 *
 * Offered in the composer as a button, never applied silently: the author may
 * have meant the emoji, and rewriting someone's copy without telling them is a
 * worse failure than an expensive send.
 */
export function toGsmSafe(body: string): string {
  let out = body;
  for (const [from, to] of GSM_SUBSTITUTIONS) out = out.split(from).join(to);
  return out;
}
