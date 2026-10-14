import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MIGRATION_PROBES,
  PENDING_MIGRATIONS_NOTICE,
  PROBE_TTL_MS,
  checkPendingMigrations,
  classifyProbe,
  isFresh,
} from "./pending-migrations.ts";

const MISSING_TABLE = { code: "PGRST205", message: "Could not find the table 'public.team_drive_links' in the schema cache" };
const MISSING_COLUMN = { code: "42703", message: "column events.live_primary_host_id does not exist" };

test("classify: no error, missing schema, anything else", () => {
  assert.equal(classifyProbe(null), "ok");
  assert.equal(classifyProbe(MISSING_TABLE), "missing");
  assert.equal(classifyProbe(MISSING_COLUMN), "missing");
  assert.equal(classifyProbe({ code: "57014", message: "canceling statement due to statement timeout" }), "unknown");
  // A HEAD request's error has no body; it must never read as "missing".
  assert.equal(classifyProbe({ message: "" }), "unknown");
});

test("a fully migrated database has nothing pending", async () => {
  const r = await checkPendingMigrations(async () => null);
  assert.deepEqual(r, { missing: [], complete: true });
});

test("each missing table or column names its migration once", async () => {
  const absent = new Set(["course_assignments", "course_assignment_submissions", "events"]);
  const r = await checkPendingMigrations(async (table) =>
    absent.has(table) ? (table === "events" ? MISSING_COLUMN : MISSING_TABLE) : null,
  );
  assert.deepEqual(r, { missing: ["0093", "0096"], complete: true });
});

test("a failed probe is not 'missing' and marks the answer incomplete", async () => {
  const r = await checkPendingMigrations(async (table) => {
    if (table === "recording_sessions") throw new Error("fetch failed");
    if (table === "team_drive_links") return MISSING_TABLE;
    return null;
  });
  assert.deepEqual(r, { missing: ["0094"], complete: false });
});

test("every probe targets a new table or column from 0093–0096", () => {
  const migrations = new Set(MIGRATION_PROBES.map((p) => p.migration));
  assert.deepEqual([...migrations].sort(), ["0093", "0094", "0095", "0096"]);
  for (const p of MIGRATION_PROBES) assert.match(p.table, /^[a-z_]+$/);
});

test("the notice is the one line the overview shows", () => {
  assert.equal(
    PENDING_MIGRATIONS_NOTICE,
    "Database update needed: run migrations 0093–0100 (docs/migrations-2026-10.md)",
  );
});

test("cache freshness", () => {
  assert.equal(isFresh(1_000, 1_000), true);
  assert.equal(isFresh(1_000, 1_000 + PROBE_TTL_MS - 1), true);
  assert.equal(isFresh(1_000, 1_000 + PROBE_TTL_MS), false);
  assert.equal(isFresh(5_000, 1_000), false);
});
