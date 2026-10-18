import test from "node:test";
import assert from "node:assert/strict";
import { GSM_SUBSTITUTIONS, countSegments, measureSms, toGsmSafe } from "./sms/segments.ts";

// Run with `npm test`. Lives at the top of lib/ rather than in lib/sms/ because
// the `test` script globs `lib/*.test.ts` and the shell expands that before Node
// sees it — a file in lib/sms/ would never run.
//
// These assert exact segment COUNTS, not "it returns a number". The counter's
// whole job is to quote a price before the send, so a measurement that is
// directionally right and numerically wrong is the same as no counter at all:
// the composer says "1 segment" and the invoice says three. Every boundary below
// is one character either side of a billing cliff.

test("a full 160-character ASCII message is exactly one GSM-7 segment", () => {
  const m = measureSms("a".repeat(160));
  assert.equal(m.encoding, "GSM-7");
  assert.equal(m.segments, 1);
  assert.equal(m.units, 160);
  assert.equal(m.capacity, 160);
  assert.deepEqual(m.nonGsmChars, []);
});

test("character 161 costs a whole second segment and drops capacity to 153", () => {
  const m = measureSms("a".repeat(161));
  assert.equal(m.segments, 2, "the concatenation header steals 7 septets per part");
  assert.equal(m.units, 161);
  assert.equal(m.capacity, 153);
  assert.equal(countSegments("a".repeat(161)), 2);
});

test("an extension-table character costs two septets, not one", () => {
  // The trap: € and { are perfectly legal GSM-7 and look like one character, so
  // a naive .length puts this message at 160 and bills it as one segment. They
  // are encoded as an escape byte plus the character, so 159 + 1 of these is 161
  // units — over the cliff — while 159 + 1 ordinary letter is exactly 160.
  assert.equal(measureSms("a".repeat(159) + "a").segments, 1);
  for (const ch of ["€", "{"]) {
    const m = measureSms("a".repeat(159) + ch);
    assert.equal(m.encoding, "GSM-7", `${ch} must not force UCS-2`);
    assert.equal(m.units, 161, `${ch} must weigh 2 septets`);
    assert.equal(m.segments, 2);
  }
  assert.equal(measureSms("€".repeat(80)).segments, 1, "80 euro signs = 160 septets");
  assert.equal(measureSms("€".repeat(81)).units, 162);
  assert.equal(measureSms("€".repeat(81)).segments, 2);
});

test("a newline stays one septet — 160 of them still fit in one segment", () => {
  // \n and \r are in the BASIC table, not the extension table. Getting this
  // wrong halves the usable length of every multi-line message.
  const m = measureSms("\n".repeat(160));
  assert.equal(m.encoding, "GSM-7");
  assert.equal(m.units, 160);
  assert.equal(m.segments, 1);
});

test("one emoji converts the entire message to UCS-2 and itself costs two units", () => {
  const m = measureSms("🎉");
  assert.equal(m.encoding, "UCS-2");
  assert.equal(m.units, 2, "outside the BMP, so a surrogate pair — two code units");
  assert.equal(m.segments, 1);
  assert.equal(m.capacity, 70);
  assert.deepEqual(m.nonGsmChars, ["🎉"]);
});

test("UCS-2 capacities are 70 single / 67 concatenated", () => {
  // 2 (emoji) + 68 = exactly 70: still one segment.
  const fits = measureSms("🎉" + "a".repeat(68));
  assert.equal(fits.segments, 1);
  assert.equal(fits.units, 70);
  assert.equal(fits.capacity, 70);

  // One character more and the header tax applies to both halves.
  const spills = measureSms("🎉" + "a".repeat(69));
  assert.equal(spills.units, 71);
  assert.equal(spills.segments, 2);
  assert.equal(spills.capacity, 67);
});

test("emoji are counted by code point, not by code unit", () => {
  // 36 emoji = 72 UCS-2 units = 2 segments. A loop over .length would see 72
  // "characters" and land on the same number by accident; a loop that treated
  // each emoji as one unit would say 1 segment and under-quote by half.
  assert.equal(measureSms("🎉".repeat(36)).units, 72);
  assert.equal(measureSms("🎉".repeat(36)).segments, 2);
  assert.deepEqual(measureSms("🎉".repeat(36)).nonGsmChars, ["🎉"], "deduped to one offender");
});

test("nonGsmChars lists the offenders deduped, in first-appearance order", () => {
  // This list is what the composer shows the author, so the order has to match
  // the order they'd scan their own copy in — not Set iteration order of a hash.
  const m = measureSms("Hey — it’s here — ’ …");
  assert.equal(m.encoding, "UCS-2");
  assert.deepEqual(m.nonGsmChars, ["—", "’", "…"]);
});

test("an empty body is one segment, not zero", () => {
  // Carriers bill a minimum of one segment, and a "0 segments" preview reads as
  // free. Capacity still reports the GSM-7 single-segment budget so the live
  // counter in the composer starts at "160 left" rather than blank.
  const m = measureSms("");
  assert.equal(m.segments, 1);
  assert.equal(m.units, 0);
  assert.equal(m.capacity, 160);
  assert.equal(m.encoding, "GSM-7");
  assert.deepEqual(m.nonGsmChars, []);
  assert.equal(countSegments(""), 1);
});

test("a curly apostrophe forces UCS-2, and toGsmSafe brings the message back", () => {
  // The single most expensive keystroke in the product: autocorrect turns ' into
  // ’ and a 100-character message silently goes from 1 segment to 2.
  const curly = measureSms("it’s time");
  assert.equal(curly.encoding, "UCS-2");
  assert.deepEqual(curly.nonGsmChars, ["’"]);

  const fixed = measureSms(toGsmSafe("it’s time"));
  assert.equal(fixed.encoding, "GSM-7");
  assert.deepEqual(fixed.nonGsmChars, []);
  assert.equal(toGsmSafe("it’s time"), "it's time");
});

test("every advertised substitution actually lands in GSM-7", () => {
  // A substitution table whose replacement is itself non-GSM would leave the
  // message in UCS-2 after the author clicked "fix", which is worse than not
  // offering the button.
  for (const [from, to] of GSM_SUBSTITUTIONS) {
    assert.equal(measureSms(from).encoding, "UCS-2", `${JSON.stringify(from)} should need fixing`);
    assert.equal(
      measureSms(to).encoding,
      "GSM-7",
      `replacement ${JSON.stringify(to)} is itself not GSM-7`,
    );
    assert.equal(measureSms(toGsmSafe(from)).encoding, "GSM-7");
  }
});

test("toGsmSafe never touches an emoji", () => {
  // Rewriting someone's copy is only acceptable for characters they did not mean
  // to type. An emoji is a deliberate choice, so it survives and the message
  // stays UCS-2 — the composer's job is then to show the price, not to edit.
  assert.equal(toGsmSafe("ship it 🎉"), "ship it 🎉");
  assert.equal(measureSms(toGsmSafe("ship it 🎉")).encoding, "UCS-2");
});
