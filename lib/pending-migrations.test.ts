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

test("classify: no error, missing schema, a leftover row, anything else", () => {
  assert.equal(classifyProbe(null), "ok");
  assert.equal(classifyProbe(MISSING_TABLE), "missing");
  assert.equal(classifyProbe(MISSING_COLUMN), "missing");
  assert.equal(classifyProbe(null, true), "missing");
  assert.equal(classifyProbe(null, false), "ok");
  assert.equal(classifyProbe({ code: "57014", message: "canceling statement due to statement timeout" }), "unknown");
  // A HEAD request's error has no body; it must never read as "missing".
  assert.equal(classifyProbe({ message: "" }), "unknown");
});

test("a fully migrated database has nothing pending", async () => {
  const r = await checkPendingMigrations(async () => ({ error: null, found: false }));
  assert.deepEqual(r, { missing: [], complete: true });
});

test("each missing table or column names its migration once", async () => {
  const absent = new Set(["course_assignments", "course_assignment_submissions", "events"]);
  const r = await checkPendingMigrations(async (p) => ({
    error: absent.has(p.table) ? (p.table === "events" ? MISSING_COLUMN : MISSING_TABLE) : null,
  }));
  assert.deepEqual(r, { missing: ["0093", "0096"], complete: true });
});

test("a leftover permission key flags 0099, 0100 or 0101", async () => {
  const r = await checkPendingMigrations(async (p) => ({
    error: null,
    found: !!p.leftover?.values.includes("ai_usage.view"),
  }));
  assert.deepEqual(r, { missing: ["0100"], complete: true });
});

test("a failed probe is not 'missing' and marks the answer incomplete", async () => {
  const r = await checkPendingMigrations(async (p) => {
    if (p.table === "recording_sessions") throw new Error("fetch failed");
    if (p.table === "team_drive_links") return { error: MISSING_TABLE };
    return { error: null };
  });
  assert.deepEqual(r, { missing: ["0094"], complete: false });
});

test("probes cover 0093–0096 and 0101 by schema, 0099–0101 by leftovers", () => {
  const schema = new Set(MIGRATION_PROBES.filter((p) => !p.leftover).map((p) => p.migration));
  const leftover = new Set(MIGRATION_PROBES.filter((p) => p.leftover).map((p) => p.migration));
  assert.deepEqual([...schema].sort(), ["0093", "0094", "0095", "0096", "0101"]);
  assert.deepEqual([...leftover].sort(), ["0099", "0100", "0101"]);
  for (const p of MIGRATION_PROBES) assert.match(p.table, /^[a-z_]+$/);
});

test("the notice is the one line the overview shows", () => {
  assert.equal(
    PENDING_MIGRATIONS_NOTICE,
    "Database update needed: run migrations 0093–0101 (docs/migrations-2026-10.md)",
  );
});

test("cache freshness", () => {
  assert.equal(isFresh(1_000, 1_000), true);
  assert.equal(isFresh(1_000, 1_000 + PROBE_TTL_MS - 1), true);
  assert.equal(isFresh(1_000, 1_000 + PROBE_TTL_MS), false);
  assert.equal(isFresh(5_000, 1_000), false);
});

test("a database without Chat, or still granting discord.manage, needs 0101", async () => {
  const noChat = await checkPendingMigrations(async (p) => ({
    error: p.table.startsWith("chat_") ? MISSING_TABLE : null,
  }));
  assert.deepEqual(noChat, { missing: ["0101"], complete: true });
  // An earlier draft of 0101 made the channels but not the mutes the posting
  // checks read: still needs this one.
  const draft = await checkPendingMigrations(async (p) => ({
    error: p.table === "chat_mutes" ? MISSING_TABLE : null,
  }));
  assert.deepEqual(draft, { missing: ["0101"], complete: true });
  const stale = await checkPendingMigrations(async (p) => ({
    error: null,
    found: !!p.leftover?.values.includes("discord.manage"),
  }));
  assert.deepEqual(stale, { missing: ["0101"], complete: true });
});
