import { test } from "node:test";
import assert from "node:assert/strict";
import { isMissingSchemaError } from "./schema-ready.ts";

// Run with `npm test`. Code ships before its migration is applied; this is
// what tells "the table/column isn't there yet" (degrade) from a real error.

test("Postgres and PostgREST 'not there' codes", () => {
  for (const code of ["42P01", "42703", "PGRST205", "PGRST204"]) {
    assert.equal(isMissingSchemaError({ code, message: "x" }), true, code);
  }
});

test("the message, when the code is missing or different", () => {
  assert.equal(isMissingSchemaError({ message: 'relation "public.recording_sessions" does not exist' }), true);
  assert.equal(isMissingSchemaError({ message: "column recording_sessions.end_reason does not exist" }), true);
  assert.equal(
    isMissingSchemaError({ code: "PGRST202", message: "Could not find the function public.recording_mint_part" }),
    true,
  );
  assert.equal(
    isMissingSchemaError({ code: "", message: "Could not find the table 'public.recording_sessions' in the schema cache" }),
    true,
  );
});

test("anything else is a real error", () => {
  assert.equal(isMissingSchemaError({ code: "23505", message: "duplicate key value violates unique constraint" }), false);
  assert.equal(isMissingSchemaError({ code: "42501", message: "permission denied for table recording_sessions" }), false);
  assert.equal(isMissingSchemaError({ code: 42703, message: "x" }), false, "a non-string code is no code");
  assert.equal(isMissingSchemaError({ message: 42 }), false);
  assert.equal(isMissingSchemaError({}), false);
  assert.equal(isMissingSchemaError(null), false);
  assert.equal(isMissingSchemaError(undefined), false);
  assert.equal(isMissingSchemaError("relation does not exist"), false, "a bare string is not an error object");
  assert.equal(isMissingSchemaError(new Error("network down")), false);
  assert.equal(isMissingSchemaError(new Error('relation "x" does not exist')), true);
});
