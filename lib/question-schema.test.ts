import { test } from "node:test";
import assert from "node:assert/strict";
import {
  answerError,
  blankQuestion,
  checkAnswers,
  formatAnswer,
  isBlankAnswer,
  normalizeQuestion,
  normalizeQuestions,
  fieldName,
  readAnswers,
  slugifyQuestionId,
  uniqueQuestionId,
  validateQuestionDraft,
  validateQuestionList,
  visibleQuestions,
  MAX_QUESTIONS,
  TEXTAREA_ANSWER_MAX,
  type CustomQuestion,
} from "./question-schema.ts";

function q(over: Partial<CustomQuestion> = {}): CustomQuestion {
  return {
    id: "biggest_risk",
    type: "textarea",
    label: "Biggest risk",
    help: "",
    placeholder: "",
    required: false,
    hidden: false,
    options: [],
    ...over,
  };
}

// --- slugify / unique ids ---------------------------------------------------

test("slugifyQuestionId produces a readable jsonb key", () => {
  assert.equal(slugifyQuestionId("Biggest risk"), "biggest_risk");
  assert.equal(slugifyQuestionId("Why now???"), "why_now");
  assert.equal(slugifyQuestionId("  spaced   out  "), "spaced_out");
});

test("slugifyQuestionId strips accents rather than turning them into underscores", () => {
  // NFKD splits é into e + U+0301; without the combining-mark strip this would
  // come back as "jos_" and read as a different question entirely.
  assert.equal(slugifyQuestionId("José"), "jose");
  assert.equal(slugifyQuestionId("Café au lait"), "cafe_au_lait");
  assert.equal(slugifyQuestionId("Über résumé"), "uber_resume");
  // NFKD decomposes accents but NOT ligature-ish letters — ß has no combining
  // form to strip, so it falls through to the non-alphanumeric replace. The id
  // is still stable and unique, which is all it has to be; the admin editor
  // shows it so anyone unhappy with "gro_e" can type a better one.
  assert.equal(slugifyQuestionId("Größe"), "gro_e");
});

test("slugifyQuestionId forces a leading letter", () => {
  assert.equal(slugifyQuestionId("2026 goals"), "q_2026_goals");
  assert.equal(slugifyQuestionId("---"), "");
  assert.equal(slugifyQuestionId(""), "");
});

test("uniqueQuestionId suffixes instead of colliding", () => {
  assert.equal(uniqueQuestionId("Why now", []), "why_now");
  assert.equal(uniqueQuestionId("Why now", ["why_now"]), "why_now_2");
  assert.equal(
    uniqueQuestionId("Why now", ["why_now", "why_now_2"]),
    "why_now_3",
  );
});

test("uniqueQuestionId never hands back a built-in field name", () => {
  // Left unguarded this would shadow applications.full_name on the merged form.
  assert.equal(uniqueQuestionId("Full name", []), "full_name_2");
  assert.equal(uniqueQuestionId("Phone", []), "phone_2");
});

// --- normalize (read path, tolerant) ---------------------------------------

test("normalizeQuestion rejects malformed entries instead of throwing", () => {
  assert.equal(normalizeQuestion(null), null);
  assert.equal(normalizeQuestion("nope"), null);
  assert.equal(normalizeQuestion({ id: "ok", type: "wat", label: "x" }), null);
  assert.equal(normalizeQuestion({ id: "9bad", type: "text", label: "x" }), null);
  assert.equal(normalizeQuestion({ id: "ok", type: "text", label: "  " }), null);
});

test("normalizeQuestion drops a choice question with no usable options", () => {
  // An empty dropdown can't be answered, so rendering it would wedge submit.
  assert.equal(
    normalizeQuestion({ id: "pick", type: "select", label: "Pick", options: [] }),
    null,
  );
  assert.equal(
    normalizeQuestion({
      id: "pick",
      type: "select",
      label: "Pick",
      options: [{ value: "", label: "blank" }],
    }),
    null,
  );
});

test("normalizeQuestion fills defaults and dedupes option values", () => {
  const out = normalizeQuestion({
    id: "pick",
    type: "radio",
    label: "Pick",
    options: [
      { value: "a", label: "A" },
      { value: "a", label: "A again" },
      { value: "b", label: "B" },
    ],
  });
  assert.ok(out);
  assert.deepEqual(out.options, [
    { value: "a", label: "A" },
    { value: "b", label: "B" },
  ]);
  assert.equal(out.help, "");
  assert.equal(out.required, false);
  assert.equal(out.hidden, false);
});

test("normalizeQuestions derives a missing id instead of dropping the question", () => {
  // Legacy tolerance for rows already in the database: both save paths fill a
  // blank id before writing now, but a row stored before they did must still
  // read under the key it would have been given rather than vanish from the
  // form. Everything else malformed still goes, id or no id.
  const out = normalizeQuestions([
    { type: "text", label: "Why now?" },
    { id: "9bad", type: "text", label: "Leading digit" },
    { id: "ok", type: "wat", label: "Bad type" },
    { id: "pick", type: "select", label: "Pick", options: [] },
  ]);
  assert.deepEqual(
    out.map((x) => x.id),
    ["why_now"],
  );
});

test("a derived id never steals one held further down the list", () => {
  // The entry below hasn't been parsed yet when the first one gets its id, so
  // its claim has to be read straight off the raw list — otherwise both take
  // `why_now` and one of them is dropped as a duplicate.
  const out = normalizeQuestions([
    { type: "text", label: "Why now?" },
    { id: "why_now", type: "text", label: "Why now, really?" },
  ]);
  assert.deepEqual(
    out.map((x) => x.id),
    ["why_now_2", "why_now"],
  );
});

test("normalizeQuestions drops duplicates and caps the list", () => {
  const raw = [
    { id: "a", type: "text", label: "A" },
    { id: "a", type: "text", label: "A dup" },
    "garbage",
    { id: "b", type: "text", label: "B" },
  ];
  assert.deepEqual(
    normalizeQuestions(raw).map((x) => x.id),
    ["a", "b"],
  );
  assert.equal(normalizeQuestions("not an array").length, 0);

  const many = Array.from({ length: MAX_QUESTIONS + 10 }, (_, i) => ({
    id: `q${i}`,
    type: "text",
    label: `Q${i}`,
  }));
  assert.equal(normalizeQuestions(many).length, MAX_QUESTIONS);
});

test("visibleQuestions hides removed questions", () => {
  const list = [q({ id: "a" }), q({ id: "b", hidden: true })];
  assert.deepEqual(
    visibleQuestions(list).map((x) => x.id),
    ["a"],
  );
});

// --- validate (admin save path, strict) ------------------------------------

test("validateQuestionDraft accepts a well-formed question", () => {
  assert.equal(validateQuestionDraft(q(), []), null);
});

test("validateQuestionDraft rejects reserved and duplicate ids", () => {
  assert.match(String(validateQuestionDraft(q({ id: "full_name" }), [])), /built-in/);
  assert.match(
    String(validateQuestionDraft(q({ id: "dupe" }), ["dupe"])),
    /unique/,
  );
});

test("validateQuestionDraft rejects a bad id shape", () => {
  assert.match(String(validateQuestionDraft(q({ id: "Bad Id" }), [])), /field id/);
  assert.match(String(validateQuestionDraft(q({ id: "9x" }), [])), /field id/);
});

test("validateQuestionDraft requires two labelled options on a choice question", () => {
  const one = q({
    id: "pick",
    type: "select",
    options: [{ value: "a", label: "A" }],
  });
  assert.match(String(validateQuestionDraft(one, [])), /at least two options/);

  const blank = q({
    id: "pick",
    type: "select",
    options: [
      { value: "a", label: "A" },
      { value: "b", label: "" },
    ],
  });
  assert.match(String(validateQuestionDraft(blank, [])), /value and a label/);

  const dupe = q({
    id: "pick",
    type: "select",
    options: [
      { value: "a", label: "A" },
      { value: "a", label: "B" },
    ],
  });
  assert.match(String(validateQuestionDraft(dupe, [])), /used twice/);
});

test("validateQuestionDraft rejects options on a non-choice type", () => {
  const bad = q({ type: "text", options: [{ value: "a", label: "A" }] });
  assert.match(String(validateQuestionDraft(bad, [])), /can't have options/);
});

test("validateQuestionDraft rejects required + removed", () => {
  // Unguarded this is unsatisfiable: the applicant is never shown the field,
  // so every submit fails with nothing they can do about it.
  const bad = q({ required: true, hidden: true });
  assert.match(String(validateQuestionDraft(bad, [])), /can't also be required/);
});

test("validateQuestionDraft doesn't claim an id is taken when it isn't", () => {
  // Reachable with a blank id when the save path's fill hasn't run — it is
  // exported for a single draft — and "every numbered variant is taken" would
  // then send the admin off rewording a question that was fine.
  const free = String(validateQuestionDraft(q({ id: "", label: "Why now?" }), []));
  assert.match(free, /field id must start with a letter/);
  assert.doesNotMatch(free, /taken/);

  // Genuinely exhausted: the base and every suffix up to the ceiling are gone.
  const taken = [
    "why_now",
    ...Array.from({ length: 49 }, (_, i) => `why_now_${i + 2}`),
  ];
  assert.match(
    String(validateQuestionDraft(q({ id: "", label: "Why now?" }), taken)),
    /every numbered variant of it are taken/,
  );
});

test("validateQuestionList reports the first problem across the list", () => {
  assert.equal(validateQuestionList([q({ id: "a" }), q({ id: "b" })]), null);
  assert.match(
    String(validateQuestionList([q({ id: "a" }), q({ id: "a" })])),
    /unique/,
  );
});

// --- the save path fills a blank id, and only a blank one -------------------
//
// The bug these cover: macOS Safari and Firefox don't focus a <button> on
// click, so the editor's blur never fires and a new question reaches the save
// path with id "". It has to come back with the key it was stored under, and
// a key that already exists has to survive a reworded label untouched.

test("validateQuestionList fills a blank id from the label, in place", () => {
  // In place because the caller stores the very array it validated — a copy
  // would be checked and thrown away, and the row would land with no key.
  const list = [q({ id: "", label: "Why now?" })];
  assert.equal(validateQuestionList(list), null);
  assert.equal(list[0].id, "why_now");
});

test("validateQuestionList never rewrites an id that already exists", () => {
  // The invariant the whole module is built around: that id is the jsonb key
  // every answer collected so far is filed under, so rewording the label must
  // leave it alone. Rewriting it orphans the answers silently.
  const list = [q({ id: "why_now", label: "Why this, now?" })];
  assert.equal(validateQuestionList(list), null);
  assert.equal(list[0].id, "why_now");
});

test("validateQuestionList gives two blank rows with one label distinct ids", () => {
  const list = [
    q({ id: "", label: "Why now?" }),
    q({ id: "", label: "Why now?" }),
  ];
  assert.equal(validateQuestionList(list), null);
  assert.deepEqual(
    list.map((x) => x.id),
    ["why_now", "why_now_2"],
  );
});

test("a filled id never steals one held further down the list", () => {
  // The second question is live — answers exist under `why_now`. The new row
  // above it has to take the suffix, not the key in use.
  const list = [
    q({ id: "", label: "Why now?" }),
    q({ id: "why_now", label: "Why now, really?" }),
  ];
  assert.equal(validateQuestionList(list), null);
  assert.deepEqual(
    list.map((x) => x.id),
    ["why_now_2", "why_now"],
  );
});

test("validateQuestionList explains a label no id can be built from", () => {
  // Both of these used to be silently DROPPED by the scholarship save path,
  // which normalized before it validated and then reported success — so the
  // admin lost the question and never saw either message.
  assert.match(
    String(validateQuestionList([q({ id: "", label: "???" })])),
    /no letter or number in this label/,
  );
  assert.match(
    String(validateQuestionList([q({ id: "", label: "" })])),
    /needs a label/,
  );
});

// --- answers ----------------------------------------------------------------

test("isBlankAnswer treats an unticked checkbox as blank", () => {
  assert.equal(isBlankAnswer(false), true);
  assert.equal(isBlankAnswer(true), false);
  assert.equal(isBlankAnswer("   "), true);
  assert.equal(isBlankAnswer(0), false);
  assert.equal(isBlankAnswer(undefined), true);
});

test("answerError enforces required only when required", () => {
  assert.equal(answerError(q(), ""), null);
  assert.match(String(answerError(q({ required: true }), "")), /is required/);
  assert.match(
    String(answerError(q({ type: "checkbox", required: true }), false)),
    /Please confirm/,
  );
});

test("answerError never runs on a removed question", () => {
  assert.equal(answerError(q({ required: true, hidden: true }), ""), null);
});

test("answerError validates each type", () => {
  assert.match(String(answerError(q({ type: "number" }), "abc")), /a number/);
  assert.equal(answerError(q({ type: "number" }), "42"), null);

  assert.match(String(answerError(q({ type: "email" }), "nope")), /valid email/);
  assert.equal(answerError(q({ type: "email" }), "a@b.co"), null);

  assert.match(String(answerError(q({ type: "date" }), "yesterday")), /valid date/);
  assert.equal(answerError(q({ type: "date" }), "2026-09-15"), null);

  const pick = q({
    type: "select",
    options: [
      { value: "a", label: "A" },
      { value: "b", label: "B" },
    ],
  });
  assert.match(String(answerError(pick, "z")), /listed options/);
  assert.equal(answerError(pick, "a"), null);
});

test("answerError accepts a bare domain for a link question", () => {
  // Applicants type "myproject.com" constantly; rejecting it teaches nothing.
  assert.equal(answerError(q({ type: "url" }), "myproject.com"), null);
  assert.equal(answerError(q({ type: "url" }), "https://myproject.com"), null);
  assert.match(String(answerError(q({ type: "url" }), "not a link")), /valid link/);
});

test("answerError caps long answers", () => {
  const long = "x".repeat(TEXTAREA_ANSWER_MAX + 1);
  assert.match(String(answerError(q({ type: "textarea" }), long)), /too long/);
});

test("checkAnswers cleans and coerces", () => {
  const questions = [
    q({ id: "risk", type: "textarea" }),
    q({ id: "hours", type: "number" }),
    q({ id: "site", type: "url" }),
    q({ id: "agree", type: "checkbox" }),
  ];
  const out = checkAnswers(questions, {
    risk: "  competition  ",
    hours: "12",
    site: "myproject.com",
    agree: true,
  });
  assert.ok(out.ok);
  assert.deepEqual(out.answers, {
    risk: "  competition  ",
    hours: 12,
    site: "https://myproject.com",
    agree: true,
  });
});

test("checkAnswers drops keys for questions that no longer exist", () => {
  // A stale browser tab must still be able to submit after an admin deletes a
  // question — losing the applicant's essay over that would be the worse bug.
  const out = checkAnswers([q({ id: "risk" })], {
    risk: "fine",
    deleted_question: "orphan",
  });
  assert.ok(out.ok);
  assert.deepEqual(Object.keys(out.answers), ["risk"]);
});

test("checkAnswers skips required checks when partial (draft autosave)", () => {
  const questions = [q({ id: "risk", required: true })];
  assert.equal(checkAnswers(questions, {}).ok, false);
  assert.equal(checkAnswers(questions, {}, { partial: true }).ok, true);
});

test("checkAnswers reports every bad field, and surfaces the first", () => {
  const questions = [
    q({ id: "a", required: true }),
    q({ id: "b", type: "email" }),
  ];
  const out = checkAnswers(questions, { b: "nope" });
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.deepEqual(Object.keys(out.errors).sort(), ["a", "b"]);
  assert.equal(out.error, out.errors.a);
});

test("checkAnswers omits blank optional answers rather than storing empties", () => {
  const out = checkAnswers([q({ id: "risk" })], { risk: "   " });
  assert.ok(out.ok);
  assert.deepEqual(out.answers, {});
});

// --- form extraction --------------------------------------------------------

test("fieldName prefixes so custom ids can't collide with built-in columns", () => {
  assert.equal(fieldName("custom", "biggest_risk"), "custom__biggest_risk");
  assert.notEqual(fieldName("custom", "full_name"), "full_name");
});

test("readAnswers turns checkbox presence into a real boolean", () => {
  // An unchecked box is ABSENT from FormData, and a checked one posts "on".
  const questions = [q({ id: "agree", type: "checkbox" })];
  assert.deepEqual(readAnswers(questions, { custom__agree: "on" }, "custom"), {
    agree: true,
  });
  assert.deepEqual(readAnswers(questions, {}, "custom"), { agree: false });
  assert.deepEqual(readAnswers(questions, { custom__agree: "false" }, "custom"), {
    agree: false,
  });
});

test("readAnswers only reads its own prefix", () => {
  const questions = [q({ id: "risk" })];
  assert.deepEqual(
    readAnswers(questions, { sch__risk: "wrong", custom__risk: "right" }, "custom"),
    { risk: "right" },
  );
});

test("readAnswers skips hidden questions and absent fields", () => {
  const questions = [q({ id: "a" }), q({ id: "b", hidden: true })];
  assert.deepEqual(readAnswers(questions, { custom__a: "x" }, "custom"), { a: "x" });
});

test("readAnswers feeds checkAnswers end to end", () => {
  const questions = [
    q({ id: "risk", required: true }),
    q({ id: "agree", type: "checkbox", required: true }),
  ];
  const posted = { custom__risk: "competition", custom__agree: "on" };
  const out = checkAnswers(questions, readAnswers(questions, posted, "custom"));
  assert.ok(out.ok);
  assert.deepEqual(out.answers, { risk: "competition", agree: true });

  // Same form with the box untouched fails the required check, as it must.
  const unticked = checkAnswers(
    questions,
    readAnswers(questions, { custom__risk: "competition" }, "custom"),
  );
  assert.equal(unticked.ok, false);
});

// --- display ----------------------------------------------------------------

test("formatAnswer renders option labels and booleans", () => {
  const pick = q({
    id: "pick",
    type: "select",
    options: [{ value: "a", label: "Option A" }],
  });
  assert.equal(formatAnswer(pick, { pick: "a" }), "Option A");
  // An option deleted after the fact still shows the raw stored value rather
  // than vanishing from the reviewer's screen.
  assert.equal(formatAnswer(pick, { pick: "gone" }), "gone");
  assert.equal(formatAnswer(q({ id: "agree", type: "checkbox" }), { agree: true }), "Yes");
  assert.equal(formatAnswer(q({ id: "agree", type: "checkbox" }), { agree: false }), "No");
});

test("formatAnswer returns empty string for an unanswered question", () => {
  assert.equal(formatAnswer(q({ id: "risk" }), {}), "");
  assert.equal(formatAnswer(q({ id: "risk" }), null), "");
});

test("blankQuestion seeds two options for a choice type only", () => {
  assert.equal(blankQuestion("text").options.length, 0);
  assert.equal(blankQuestion("select").options.length, 2);
  assert.equal(blankQuestion().id, "");
});
