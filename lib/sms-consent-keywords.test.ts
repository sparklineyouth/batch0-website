import test from "node:test";
import assert from "node:assert/strict";
import { classifyInbound, expressesRevocation } from "./sms/keywords.ts";

// Run with `npm test`. At the top of lib/ rather than in lib/sms/ because the
// `test` script globs `lib/*.test.ts` and the shell expands that before Node
// sees it — a file one directory down would never run.
//
// What is under test is classifyInbound, the function that decides whether an
// inbound text is an opt-out. Getting it wrong in either direction is a real
// harm: a missed STOP is a revocation we failed to honour inside the
// ten-business-day rule, and a false positive unsubscribes someone who asked a
// question and then wonders why we went silent. So the negative cases below
// matter as much as the positive ones.
//
// Imported directly, with no loader shim: lib/sms/keywords.ts has no imports, so
// `node --test` can resolve it. That is the reason it was split out of
// lib/sms/consent.ts, which reaches Supabase through the "@/…" alias that the
// test runner cannot resolve.


// ---------------------------------------------------------------------------
// The keyword classifier
// ---------------------------------------------------------------------------

test("the CTIA opt-out keywords are honoured", () => {
  for (const body of ["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT", "REMOVE"]) {
    assert.equal(classifyInbound(body), "stop", body);
  }
});

test("case and trailing punctuation do not hide a STOP", () => {
  // "stop." and " Stop. " are what a phone keyboard produces unprompted. Treating
  // either as unrecognised is the failure the revocation rule exists to punish.
  for (const body of ["stop", "Stop", " Stop. ", "STOP!", "stop?", "stop;", "  STOP  ", '"stop"']) {
    assert.equal(classifyInbound(body), "stop", JSON.stringify(body));
  }
});

test("the two-word opt-out variants are matched after whitespace collapses", () => {
  for (const body of ["OPT OUT", "opt out", "opt  out", " Opt Out. "]) {
    assert.equal(classifyInbound(body), "stop", JSON.stringify(body));
  }
  assert.equal(classifyInbound("optout"), "stop");
});

test("START, YES and UNSTOP all re-subscribe", () => {
  for (const body of ["START", "start", "Start!", "YES", "yes", "unstop", "UNSTOP", "SUBSCRIBE", "OPT IN", "optin"]) {
    assert.equal(classifyInbound(body), "start", JSON.stringify(body));
  }
});

test("HELP and INFO ask for the help message", () => {
  for (const body of ["HELP", "help", "Help.", "INFO", "info"]) {
    assert.equal(classifyInbound(body), "help", JSON.stringify(body));
  }
});

test("a sentence that merely CONTAINS a keyword is not an opt-out", () => {
  // The whole reason matching is on the complete body rather than a substring.
  // Every one of these is a human talking to us, and unsubscribing them — or
  // worse, replying with the opt-out confirmation — ends the conversation.
  assert.equal(classifyInbound("Can you stop by Thursday?"), "other");
  assert.equal(classifyInbound("stop sending these to my mom's phone"), "other");
  assert.equal(classifyInbound("The session ended early"), "other");
  assert.equal(classifyInbound("Please cancel my Thursday slot"), "other");
});

test("a sentence that merely CONTAINS START is not an opt-in either", () => {
  // The dangerous direction: treating this as consent would manufacture an opt-in
  // out of small talk, which is exactly the record we would have to produce in a
  // complaint and could not defend.
  assert.equal(classifyInbound("I want to start next week"), "other");
  assert.equal(classifyInbound("yes I can make it"), "other");
  assert.equal(classifyInbound("when does the cohort start"), "other");
});

test("an ordinary question routes to human review, not to an automated reply", () => {
  assert.equal(classifyInbound("Can someone help me with the pitch deck?"), "other");
  assert.equal(classifyInbound("Is the call at 6 or 7?"), "other");
  assert.equal(classifyInbound(""), "other", "an empty body is not a keyword");
  assert.equal(classifyInbound("   "), "other");
  assert.equal(classifyInbound("👍"), "other");
});

test("the three intents are mutually exclusive on every keyword we honour", () => {
  // STOP is checked first on purpose: if a word ever appeared in two tables, the
  // suppressing interpretation has to win. This asserts no word does.
  const byIntent = new Map<string, string[]>();
  for (const word of [
    "stop", "stopall", "unsubscribe", "cancel", "end", "quit", "optout", "opt out", "remove",
    "start", "unstop", "yes", "optin", "opt in", "subscribe",
    "help", "info",
  ]) {
    const intent = classifyInbound(word);
    assert.notEqual(intent, "other", `${word} is advertised as a keyword but classifies as other`);
    byIntent.set(intent, [...(byIntent.get(intent) ?? []), word]);
  }
  assert.deepEqual([...byIntent.keys()].sort(), ["help", "start", "stop"]);
});

// ---------------------------------------------------------------------------
// Regressions from the adversarial review
// ---------------------------------------------------------------------------

test("REVOKE is honoured — the FCC's revocation rule names it explicitly", () => {
  for (const body of ["REVOKE", "revoke", "Revoke.", "revoke consent", "REVOKE CONSENT"]) {
    assert.equal(classifyInbound(body), "stop", JSON.stringify(body));
  }
});

test("hyphenated and dashed spellings reach the same verdict as spaced ones", () => {
  // "opt out" and "optout" were both honoured while "opt-out" — the spelling
  // people actually type — fell through to "other".
  for (const body of ["opt-out", "OPT-OUT", "opt\u2010out", "opt\u2014out", "opt_out"]) {
    assert.equal(classifyInbound(body), "stop", JSON.stringify(body));
  }
  assert.equal(classifyInbound("stop-all"), "stop");
  assert.equal(classifyInbound("opt-in"), "start");
});

test("dash folding does not turn a sentence into a keyword", () => {
  // The whole-body rule still has to hold after the extra normalization.
  assert.equal(classifyInbound("stop - by on thursday?"), "other");
  assert.equal(classifyInbound("re-start my application"), "other");
});

// ---------------------------------------------------------------------------
// Revocation in a sentence — expressesRevocation
//
// The FCC rule (47 CFR 64.1200(a)(10), in force since April 11, 2025) counts a
// reply in other words as a revocation when a reasonable person would read it
// as one, and the privacy policy promises we honour "any other reasonable
// way". Nobody reads this number, so the webhook asks this of everything
// classifyInbound calls "other" — and these cases are what it answers.
// ---------------------------------------------------------------------------

test("a sentence asking us to stop is a revocation, even though it isn't a keyword", () => {
  for (const body of [
    "please stop texting me",
    "Stop texting me.",
    "stop sending these to my mom's phone",
    "Can you stop messaging this number",
    "don't text me anymore",
    "don’t text me", // the curly apostrophe a phone keyboard sends
    "do not text this number",
    "no more texts please",
    "Remove me from this list",
    "take me off your list",
    "unsubscribe me",
    "I want to opt out",
    "opt me out",
    "I revoke my consent",
    "wrong number",
    "Wrong number!! who is this",
    "leave me alone",
  ]) {
    assert.equal(classifyInbound(body), "other", `${JSON.stringify(body)} is not an exact keyword`);
    assert.equal(expressesRevocation(body), true, JSON.stringify(body));
  }
});

test("a STOP keyword said politely is still a STOP", () => {
  for (const body of ["please stop", "STOP NOW", "stop it", "Stop please, thanks", "end it", "quit pls", "STOP STOP"]) {
    assert.equal(expressesRevocation(body), true, JSON.stringify(body));
  }
});

test("every exact STOP keyword is a revocation too", () => {
  for (const body of ["STOP", "unsubscribe", "cancel", "end", "quit", "opt-out", "revoke"]) {
    assert.equal(expressesRevocation(body), true, body);
  }
});

test("a sentence that only mentions a keyword in passing is not a revocation", () => {
  // Each of these uses a STOP word for something else. The rule errs towards
  // revoking, but "please cancel my Thursday slot" is about a slot.
  for (const body of [
    "Can you stop by Thursday?",
    "Please cancel my Thursday slot",
    "The session ended early",
    "what time does it end",
    "Is the call at 6 or 7?",
    "I want to start next week",
    "yes I can make it",
    "help me with the deck",
    "",
    "   ",
    "👍",
  ]) {
    assert.equal(expressesRevocation(body), false, JSON.stringify(body));
  }
});

test("START and HELP are never read as a revocation", () => {
  for (const body of ["START", "unstop", "YES", "HELP", "info", "opt in"]) {
    assert.equal(expressesRevocation(body), false, body);
  }
});
