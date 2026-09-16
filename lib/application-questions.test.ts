import { test } from "node:test";
import assert from "node:assert/strict";
import { RESERVED_QUESTION_IDS } from "./question-schema.ts";

// lib/application-questions.ts imports the Supabase admin client, so it can't
// be loaded under `node --test` (no @/ alias, no env). The skeleton itself is a
// frozen literal though, so the one cross-module invariant that actually
// matters is checkable by reading the source.
//
// THE INVARIANT: every built-in field key must appear in
// RESERVED_QUESTION_IDS. question-schema.ts lists them as plain strings to
// stay import-free, and promises in a comment that this test keeps the two
// lists in agreement. Without it, an admin could add a custom question with
// id "school", which would collide with the column-backed built-in on the
// merged form and silently shadow one of the two.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "application-questions.ts"), "utf8");

/** Pull the `key: "..."` literals out of the frozen QUESTION_FIELDS array. */
function builtinKeys(): string[] {
  const start = source.indexOf("export const QUESTION_FIELDS");
  assert.ok(start > -1, "QUESTION_FIELDS not found — did the export get renamed?");
  const end = source.indexOf("QUESTION_FIELD_MAP", start);
  const block = source.slice(start, end > -1 ? end : undefined);
  return [...block.matchAll(/^\s{4}key:\s*"([a-z_]+)",/gm)].map((m) => m[1]);
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
  const declared = source.match(
    /export const REQUIRED_CORE_KEYS = \[([\s\S]*?)\] as const;/,
  );
  assert.ok(declared, "REQUIRED_CORE_KEYS not found");
  const declaredKeys = [...declared[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
  assert.deepEqual(declaredKeys.sort(), [...cores].sort());
});
