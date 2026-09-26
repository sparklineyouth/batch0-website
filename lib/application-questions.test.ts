import { test } from "node:test";
import assert from "node:assert/strict";
import { RESERVED_QUESTION_IDS } from "./question-schema.ts";
import { QUESTION_FIELDS, REQUIRED_CORE_KEYS } from "./application-fields.ts";

// The skeleton lives in lib/application-fields.ts, which is import-free
// precisely so it can be loaded here (lib/application-questions.ts imports the
// Supabase admin client and can't be — no @/ alias, no env under node --test).
//
// THE INVARIANT: every built-in field key must appear in
// RESERVED_QUESTION_IDS. question-schema.ts lists them as plain strings to
// stay import-free, and promises in a comment that this test keeps the two
// lists in agreement. Without it, an admin could add a custom question with
// id "school", which would collide with the column-backed built-in on the
// merged form and silently shadow one of the two.

function builtinKeys(): string[] {
  return QUESTION_FIELDS.map((f) => f.key);
}

test("the built-in skeleton still has all 17 fields", () => {
  assert.equal(builtinKeys().length, 17);
});

test("every built-in field key is reserved against custom questions", () => {
  const missing = builtinKeys().filter((k) => !RESERVED_QUESTION_IDS.includes(k));
  assert.deepEqual(
    missing,
    [],
    `These built-in fields are missing from RESERVED_QUESTION_IDS in question-schema.ts: ${missing.join(", ")}. An admin could add a custom question with the same id and shadow the column-backed field.`,
  );
});

test("the five server-required cores are all real fields", () => {
  // If a core key were misspelled, applyGuardrails would silently protect
  // nothing and SubmitSchema would start rejecting submissions for a field the
  // admin was allowed to hide.
  const cores = ["full_name", "age", "phone", "why_join", "team_size"];
  const keys = builtinKeys();
  for (const core of cores) {
    assert.ok(keys.includes(core), `${core} is not a built-in field`);
  }
  const declaredKeys = [...REQUIRED_CORE_KEYS] as string[];
  assert.deepEqual(declaredKeys.sort(), [...cores].sort());
});
