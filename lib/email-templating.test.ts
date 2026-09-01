import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sanitizeEmailHtml,
  htmlToText,
  isSafeUrl,
} from "./email/sanitize.ts";
import {
  interpolate,
  extractTags,
  missingRequired,
  exampleValues,
  firstNameOf,
  isValidVariableKey,
} from "./email/vars.ts";
import {
  parseCron,
  cronMatches,
  cronError,
  wasDue,
  nextRun,
} from "./email/cron.ts";

// Run with `npm test`. No framework, no transpile — Node strips the types,
// which is why lib/email/{sanitize,vars,cron}.ts are kept import-free.
//
// These three are the modules where a bug is both silent and expensive: the
// sanitizer decides what markup reaches a recipient's inbox, the interpolator
// decides whether a real name lands in a greeting, and the cron matcher
// decides whether a scheduled send happens at all.

// ---------------------------------------------------------------------------
// sanitize
// ---------------------------------------------------------------------------

test("keeps the tags an email body is made of", () => {
  const html =
    "<p>Hi <strong>Alex</strong></p><ul><li>one</li></ul><a href=\"https://batch0.org\">link</a>";
  assert.equal(sanitizeEmailHtml(html), html);
});

test("drops script tags along with their contents", () => {
  const out = sanitizeEmailHtml('<p>ok</p><script>alert("x")</script><p>after</p>');
  assert.equal(out, "<p>ok</p><p>after</p>");
  assert.ok(!out.includes("alert"));
});

test("unwraps unknown tags but keeps their text", () => {
  assert.equal(sanitizeEmailHtml("<marquee>hello</marquee>"), "hello");
});

test("strips event handlers and unknown attributes", () => {
  const out = sanitizeEmailHtml('<p onclick="steal()" class="x" id="y">hi</p>');
  assert.equal(out, "<p>hi</p>");
});

test("removes javascript: hrefs, including entity-encoded ones", () => {
  assert.equal(
    sanitizeEmailHtml('<a href="javascript:alert(1)">x</a>'),
    "<a>x</a>",
  );
  assert.equal(
    sanitizeEmailHtml('<a href="&#106;avascript:alert(1)">x</a>'),
    "<a>x</a>",
  );
  // Control characters inside the scheme are ignored by real clients.
  assert.equal(
    sanitizeEmailHtml('<a href="java\tscript:alert(1)">x</a>'),
    "<a>x</a>",
  );
});

test("isSafeUrl accepts the shapes a template legitimately uses", () => {
  assert.ok(isSafeUrl("https://batch0.org/apply"));
  assert.ok(isSafeUrl("mailto:hello@batch0.org"));
  assert.ok(isSafeUrl("{{reset_url}}"));
  assert.ok(isSafeUrl("/dashboard"));
  assert.ok(!isSafeUrl("javascript:alert(1)"));
  assert.ok(!isSafeUrl("data:text/html;base64,PHNjcmlwdD4="));
  assert.ok(!isSafeUrl("vbscript:msgbox"));
});

test("filters inline styles down to the allowed properties", () => {
  const out = sanitizeEmailHtml(
    '<p style="color:red;position:fixed;background:url(http://evil/x.png)">hi</p>',
  );
  assert.equal(out, '<p style="color:red">hi</p>');
});

test("closes tags the author left open so markup can't leak into the layout", () => {
  assert.equal(sanitizeEmailHtml("<p>one<p>two"), "<p>one<p>two</p></p>");
  assert.equal(sanitizeEmailHtml("<strong>bold"), "<strong>bold</strong>");
});

test("ignores stray closing tags", () => {
  assert.equal(sanitizeEmailHtml("hello</div>there"), "hellothere");
});

test("leaves merge tags alone", () => {
  assert.equal(
    sanitizeEmailHtml("<p>Hi {{first_name}}</p>"),
    "<p>Hi {{first_name}}</p>",
  );
});

test("adds rel=noopener when a link opens in a new tab", () => {
  const out = sanitizeEmailHtml(
    '<a href="https://x.test" target="_blank">x</a>',
  );
  assert.ok(out.includes('rel="noopener noreferrer"'));
});

test("escapes bare angle brackets in text", () => {
  assert.equal(sanitizeEmailHtml("5 < 6 & 7 > 2"), "5 &lt; 6 &amp; 7 &gt; 2");
});

test("htmlToText produces a readable plain-text part", () => {
  const text = htmlToText(
    '<h1>Hi</h1><p>Welcome to <strong>batch0</strong>.</p><ul><li>one</li><li>two</li></ul><a href="https://batch0.org/apply">Apply</a>',
  );
  assert.match(text, /Hi/);
  assert.match(text, /• one/);
  assert.match(text, /Apply \(https:\/\/batch0\.org\/apply\)/);
  assert.ok(!text.includes("<"));
});

// ---------------------------------------------------------------------------
// vars
// ---------------------------------------------------------------------------

test("fills tags and tolerates surrounding whitespace", () => {
  assert.equal(
    interpolate("Hi {{first_name}}, welcome to {{ cohort_name }}.", {
      first_name: "Alex",
      cohort_name: "Cohort 1",
    }),
    "Hi Alex, welcome to Cohort 1.",
  );
});

test("escapes interpolated values in HTML sinks", () => {
  assert.equal(
    interpolate("<p>{{name}}</p>", { name: '<img src=x onerror="y">' }),
    "<p>&lt;img src=x onerror=&quot;y&quot;&gt;</p>",
  );
});

test("does not escape when the sink is plain text", () => {
  assert.equal(
    interpolate("{{name}} & co", { name: "Smith & Sons" }, { escape: false }),
    "Smith & Sons & co",
  );
});

test("uses the inline fallback when a value is missing or blank", () => {
  assert.equal(interpolate("Hi {{name|there}}", {}), "Hi there");
  assert.equal(interpolate("Hi {{name|there}}", { name: "   " }), "Hi there");
  assert.equal(interpolate("Hi {{name|there}}", { name: "Alex" }), "Hi Alex");
});

test("leaves an unresolvable tag visible rather than blanking it", () => {
  // A visible {{cohort_name}} in a test send gets reported. An empty gap
  // reads as finished copy and ships.
  assert.equal(interpolate("Your {{cohort_name}} seat", {}), "Your {{cohort_name}} seat");
});

test("extractTags reports each tag once, in order", () => {
  assert.deepEqual(
    extractTags("{{a}} {{b}} {{a}}", "{{c}}"),
    ["a", "b", "c"],
  );
});

test("missingRequired only complains about declared required tags", () => {
  const declared = [
    { key: "cohort_name", label: "Cohort", example: "C1", required: true },
    { key: "notes", label: "Notes", example: "" },
  ];
  assert.deepEqual(missingRequired(declared, {}), ["cohort_name"]);
  assert.deepEqual(missingRequired(declared, { cohort_name: "Cohort 1" }), []);
  assert.deepEqual(missingRequired(declared, { cohort_name: "  " }), ["cohort_name"]);
});

test("exampleValues covers tags the author used but never declared", () => {
  const values = exampleValues([], ["first_name", "made_up_tag"]);
  assert.equal(values.first_name, "Alex");
  assert.equal(values.made_up_tag, "[made_up_tag]");
});

test("firstNameOf never returns an empty greeting", () => {
  assert.equal(firstNameOf("Alex Rivera"), "Alex");
  assert.equal(firstNameOf(""), "there");
  assert.equal(firstNameOf(null), "there");
  assert.equal(firstNameOf("   "), "there");
});

test("variable keys must match what the interpolator can see", () => {
  assert.ok(isValidVariableKey("first_name"));
  assert.ok(isValidVariableKey("team.name"));
  assert.ok(!isValidVariableKey("first name"));
  assert.ok(!isValidVariableKey("1st"));
  assert.ok(!isValidVariableKey(""));
});

// ---------------------------------------------------------------------------
// cron
// ---------------------------------------------------------------------------

const at = (iso: string) => new Date(iso);

test("matches a weekly schedule", () => {
  const p = parseCron("0 14 * * 1"); // Mondays 14:00 UTC
  assert.ok(cronMatches(p, at("2026-08-31T14:00:00Z"))); // a Monday
  assert.ok(!cronMatches(p, at("2026-08-31T14:01:00Z")));
  assert.ok(!cronMatches(p, at("2026-09-01T14:00:00Z"))); // Tuesday
});

test("accepts names, lists, ranges, and steps", () => {
  assert.ok(cronMatches(parseCron("0 9 * * MON"), at("2026-08-31T09:00:00Z")));
  assert.ok(cronMatches(parseCron("0 9,17 * * *"), at("2026-08-31T17:00:00Z")));
  assert.ok(cronMatches(parseCron("0 9-11 * * *"), at("2026-08-31T10:00:00Z")));
  assert.ok(cronMatches(parseCron("*/15 * * * *"), at("2026-08-31T10:30:00Z")));
  assert.ok(!cronMatches(parseCron("*/15 * * * *"), at("2026-08-31T10:31:00Z")));
});

test("treats 7 as Sunday", () => {
  assert.ok(cronMatches(parseCron("0 0 * * 7"), at("2026-08-30T00:00:00Z")));
});

test("ORs day-of-month with weekday when both are restricted", () => {
  const p = parseCron("0 9 1 * MON");
  assert.ok(cronMatches(p, at("2026-09-01T09:00:00Z"))); // the 1st (a Tuesday)
  assert.ok(cronMatches(p, at("2026-09-07T09:00:00Z"))); // a Monday
  assert.ok(!cronMatches(p, at("2026-09-02T09:00:00Z")));
});

test("rejects malformed expressions with a usable message", () => {
  assert.match(cronError("0 14 * *") ?? "", /5 fields/);
  assert.match(cronError("0 99 * * *") ?? "", /outside 0-23/);
  assert.match(cronError("0 14 * * funday") ?? "", /isn't a number/);
  assert.match(cronError("0 11-9 * * *") ?? "", /Reversed range/);
  assert.equal(cronError("0 14 * * 1"), null);
});

test("wasDue catches a fire that happened between two drain ticks", () => {
  const p = parseCron("0 14 * * 1");
  const now = at("2026-08-31T14:04:00Z"); // drainer runs 4 min after the fire
  assert.ok(wasDue(p, at("2026-08-31T13:59:00Z"), now));
  // Already ran this minute — must not fire again.
  assert.ok(!wasDue(p, at("2026-08-31T14:00:00Z"), now));
});

test("wasDue caps catch-up so a long pause doesn't release a backlog", () => {
  const p = parseCron("0 14 * * *"); // daily
  const now = at("2026-08-31T14:04:00Z");
  // Last run a month ago: it fires once, not thirty times — and crucially
  // the walk is bounded rather than scanning a month of minutes.
  assert.ok(wasDue(p, at("2026-07-31T14:00:00Z"), now));
});

test("nextRun finds the following fire", () => {
  const p = parseCron("0 14 * * 1");
  const next = nextRun(p, at("2026-08-31T14:00:00Z"));
  assert.equal(next?.toISOString(), "2026-09-07T14:00:00.000Z");
});
