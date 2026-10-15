import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  CHAT_SWEEP_LIMITS,
  isChatFolderName,
  isChatUploadPath,
  selectChatOrphans,
  sweepUnsentChatFiles,
  triageChatFiles,
  type FindRecorded,
  type ListedEntry,
  type SweepStorage,
} from "./chat-housekeeping.ts";
import { chatUploadPath } from "./chat-files-rules.ts";

// ---------------------------------------------------------------------------
// Fixtures: an in-memory chat-files bucket and the in-use lookup
// ---------------------------------------------------------------------------

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-10-15T13:30:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

function uuid(n: number): string {
  const hex = n.toString(16);
  return `${hex.padStart(8, "0")}-0000-4000-8000-${hex.padStart(12, "0")}`;
}
let seq = 500_000;
const channel = (n: number) => uuid(1_000 + n);
const person = (n: number) => uuid(2_000 + n);
/** A path exactly as mintChatUploads builds one. */
const upload = (ch: number, who: number, name = "IMG_2041.HEIC.png") => chatUploadPath(channel(ch), person(who), uuid(++seq), name);

type Stamp = { created_at: string | null; updated_at: string | null };

/** Answers list() like storage: one level deep, folders with a null id, name order, limit/offset pages. */
function fakeBucket(initial: Record<string, string | Stamp> = {}) {
  const objects = new Map<string, Stamp>();
  const put = (path: string, at: string | Stamp) =>
    objects.set(path, typeof at === "string" ? { created_at: at, updated_at: at } : at);
  for (const [path, at] of Object.entries(initial)) put(path, at);
  const calls = {
    list: [] as { prefix: string; limit: number; offset: number }[],
    remove: [] as string[][],
    /** Every call in order, "list" or "remove". */
    order: [] as string[],
  };
  const faults = {
    list: null as ((prefix: string, offset: number) => string | null) | null,
    remove: null as ((paths: string[]) => string | null) | null,
  };
  const storage: SweepStorage = {
    async list(prefix, page) {
      calls.list.push({ prefix, ...page });
      calls.order.push("list");
      const fault = faults.list?.(prefix, page.offset);
      if (fault) return { data: null, error: { message: fault } };
      const base = prefix === "" ? "" : `${prefix}/`;
      const folders = new Set<string>();
      const entries: ListedEntry[] = [];
      for (const [path, stamp] of objects) {
        if (!path.startsWith(base)) continue;
        const rest = path.slice(base.length);
        const slash = rest.indexOf("/");
        if (slash >= 0) folders.add(rest.slice(0, slash));
        else entries.push({ name: rest, id: `object:${path}`, ...stamp });
      }
      for (const name of folders) entries.push({ name, id: null, created_at: null, updated_at: null });
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      return { data: entries.slice(page.offset, page.offset + page.limit), error: null };
    },
    async remove(paths) {
      calls.remove.push([...paths]);
      calls.order.push("remove");
      const fault = faults.remove?.(paths);
      if (fault) return { data: null, error: { message: fault } };
      return { data: paths.filter((p) => objects.delete(p)).map((name) => ({ name })), error: null };
    },
  };
  return { objects, put, storage, calls, faults };
}

/** chat_files_in_use, as the sweep sees it: the set of paths a message or revision points at. */
function fakeInUse(rows: Iterable<string> = []) {
  const used = new Set(rows);
  const calls: string[][] = [];
  const faults = {
    read: null as ((call: number) => string | null) | null,
    afterRead: null as ((call: number) => void) | null,
  };
  const findInUse: FindRecorded = async (paths) => {
    const call = calls.push([...paths]) - 1;
    const fault = faults.read?.(call);
    if (fault) return { data: null, error: { message: fault } };
    const data = paths.filter((p) => used.has(p));
    faults.afterRead?.(call);
    return { data, error: null };
  };
  return { used, calls, faults, findInUse };
}

const NO_GUARD = { minOrphans: Number.POSITIVE_INFINITY };
const run = (
  bucket: ReturnType<typeof fakeBucket>,
  db: ReturnType<typeof fakeInUse>,
  extra: Partial<Parameters<typeof sweepUnsentChatFiles>[0]> = {},
) => sweepUnsentChatFiles({ storage: bucket.storage, findInUse: db.findInUse, now: NOW, ...extra });
const sorted = (xs: Iterable<string>) => [...xs].sort();

// ---------------------------------------------------------------------------
// What goes and what stays
// ---------------------------------------------------------------------------

test("deletes an upload no message points at once it's past a day; keeps sent ones", async () => {
  const sent = upload(1, 1);
  const unsent = upload(1, 1);
  const otherChannel = upload(2, 3);
  const bucket = fakeBucket({ [sent]: ago(3 * DAY), [unsent]: ago(2 * DAY), [otherChannel]: ago(DAY + 1) });
  const report = await run(bucket, fakeInUse([sent]));
  assert.deepEqual(sorted(bucket.objects.keys()), [sent]);
  assert.equal(report.removed, 2);
  assert.equal(report.halted, false);
  assert.equal(report.errors, 0);
  assert.deepEqual(report.folders, { examined: 2, total: 2 });
});

test("never touches anything a day old or younger", async () => {
  const fresh = upload(1, 1);
  const exactlyADay = upload(1, 1);
  const future = upload(1, 1);
  const bucket = fakeBucket({ [fresh]: ago(HOUR), [exactlyADay]: ago(DAY), [future]: new Date(NOW + HOUR).toISOString() });
  const report = await run(bucket, fakeInUse());
  assert.equal(bucket.objects.size, 3);
  assert.equal(report.removed, 0);
});

test("the later timestamp decides, and an undated file is never old", async () => {
  const rewritten = upload(1, 1);
  const undated = upload(1, 1);
  const bucket = fakeBucket({
    [rewritten]: { created_at: ago(5 * DAY), updated_at: ago(HOUR) },
    [undated]: { created_at: null, updated_at: "not a date" },
  });
  const report = await run(bucket, fakeInUse());
  assert.equal(bucket.objects.size, 2);
  assert.match(report.notes.join(" "), /1 file with no readable timestamp/);
});

test("only the <channel>/<uploader>/<uuid>-<name> layout is judged; anything else is left alone", async () => {
  const ours = upload(1, 1);
  const strays = {
    "README.txt": ago(9 * DAY), // a file at the top
    [`not-a-uuid/${person(1)}/${uuid(9)}-x.png`]: ago(9 * DAY), // a folder the app didn't make
    [`${channel(1)}/loose.png`]: ago(9 * DAY), // a file directly in a channel folder
    [`${channel(1)}/${person(1)}/no-uuid-prefix.png`]: ago(9 * DAY), // not chatUploadPath's shape
    [`${channel(1)}/${person(1)}/deeper/${uuid(10)}-x.png`]: ago(9 * DAY), // nested below an uploader
    [`${channel(1).toUpperCase()}/${person(1)}/${uuid(11)}-x.png`]: ago(9 * DAY), // upper case: not ours
  };
  const bucket = fakeBucket({ [ours]: ago(9 * DAY), ...strays });
  const report = await run(bucket, fakeInUse(), { guard: NO_GUARD });
  assert.deepEqual(sorted(bucket.objects.keys()), sorted(Object.keys(strays)));
  assert.equal(report.removed, 1);
  assert.ok(!bucket.calls.list.some((c) => c.prefix.startsWith("not-a-uuid") || c.prefix.startsWith(channel(1).toUpperCase())));
  assert.match(report.notes.join(" "), /outside the <channel>\/<uploader>\/… layout left alone/);
});

// ---------------------------------------------------------------------------
// Never on a doubt
// ---------------------------------------------------------------------------

test("a failed in-use read deletes nothing — an error is not 'nobody'", async () => {
  const a = upload(1, 1);
  const bucket = fakeBucket({ [a]: ago(3 * DAY) });
  const db = fakeInUse();
  db.faults.read = () => "connection reset";
  const report = await run(bucket, db);
  assert.equal(bucket.objects.size, 1);
  assert.equal(report.removed, 0);
  assert.equal(report.errors, 1);
  assert.match(report.notes.join(" "), /chat_files_in_use couldn't be read 1 time/);
});

test("an answer with no list in it is a failed read too", async () => {
  const a = upload(1, 1);
  const bucket = fakeBucket({ [a]: ago(3 * DAY) });
  const report = await sweepUnsentChatFiles({
    storage: bucket.storage,
    findInUse: async () => ({ data: null, error: null }),
    now: NOW,
  });
  assert.equal(bucket.objects.size, 1);
  assert.equal(report.errors, 1);
});

test("the read that licenses a delete is fresh: a file sent mid-sweep is kept", async () => {
  const a = upload(1, 1);
  const b = upload(1, 1);
  const bucket = fakeBucket({ [a]: ago(3 * DAY), [b]: ago(3 * DAY) });
  const db = fakeInUse();
  db.faults.afterRead = (call) => {
    if (call === 0) db.used.add(a); // sent between the first read and the delete
  };
  const report = await run(bucket, db);
  assert.deepEqual(sorted(bucket.objects.keys()), [a]);
  assert.equal(report.removed, 1);
  assert.match(report.notes.join(" "), /1 file was sent in a message while the sweep ran/);
});

test("a delete that fails is counted as an error and skipped, not as removed", async () => {
  const a = upload(1, 1);
  const bucket = fakeBucket({ [a]: ago(3 * DAY) });
  bucket.faults.remove = () => "503";
  const report = await run(bucket, fakeInUse());
  assert.equal(report.removed, 0);
  assert.equal(report.skipped, 1);
  assert.equal(report.errors, 1);
});

test("the top of the bucket unlistable throws before anything is deleted", async () => {
  const bucket = fakeBucket({ [upload(1, 1)]: ago(3 * DAY) });
  bucket.faults.list = (prefix) => (prefix === "" ? "Bucket not found" : null);
  await assert.rejects(run(bucket, fakeInUse()), /listing the chat-files bucket failed: Bucket not found/);
  assert.equal(bucket.calls.remove.length, 0);
});

test("a channel folder that can't be listed is skipped; the rest still runs", async () => {
  const a = upload(1, 1);
  const b = upload(2, 1);
  const bucket = fakeBucket({ [a]: ago(3 * DAY), [b]: ago(3 * DAY) });
  bucket.faults.list = (prefix) => (prefix === channel(1) ? "timeout" : null);
  const report = await run(bucket, fakeInUse());
  assert.deepEqual(sorted(bucket.objects.keys()), [a]);
  assert.equal(report.errors, 1);
});

test("the mass-deletion guard: when most old files look unreferenced, nothing is deleted", async () => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 60; i++) files[upload(1, i % 3)] = ago(3 * DAY);
  const bucket = fakeBucket(files);
  const report = await run(bucket, fakeInUse());
  assert.equal(report.halted, true);
  assert.equal(report.removed, 0);
  assert.equal(bucket.objects.size, 60);
  assert.match(report.notes.join(" "), /looks like lost rows/);
  // A bucket where most old files ARE in messages sweeps normally.
  const used = Object.keys(files).slice(0, 50);
  const report2 = await run(bucket, fakeInUse(used));
  assert.equal(report2.halted, false);
  assert.equal(report2.removed, 10);
});

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

test("pages through a folder longer than one page, and lists it whole before deleting", async () => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 250; i++) files[upload(1, 1)] = ago(3 * DAY);
  const bucket = fakeBucket(files);
  const report = await run(bucket, fakeInUse(), { guard: NO_GUARD });
  assert.equal(report.removed, 250);
  assert.equal(bucket.objects.size, 0);
  // Three pages of the uploader's folder, every one listed before the first delete.
  assert.equal(bucket.calls.list.filter((c) => c.prefix === `${channel(1)}/${person(1)}`).length, 3);
  assert.equal(bucket.calls.order.lastIndexOf("list") < bucket.calls.order.indexOf("remove"), true);
});

test("stops looking after the object budget and deleting at the removal budget", async () => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 30; i++) files[upload(1, i)] = ago(3 * DAY);
  const looked = await run(fakeBucket(files), fakeInUse(), { guard: NO_GUARD, limits: { objects: 10 } });
  assert.equal(looked.examined, 10);
  assert.match(looked.notes.join(" "), /stopped after looking at 10 objects/);
  const bucket = fakeBucket(files);
  const removed = await run(bucket, fakeInUse(), { guard: NO_GUARD, limits: { removals: 7 } });
  assert.equal(removed.removed, 7);
  assert.equal(bucket.objects.size, 23);
  assert.match(removed.notes.join(" "), /stopped at 7 deletions/);
});

test("out of time: starts nothing, or stops opening folders", async () => {
  const bucket = fakeBucket({ [upload(1, 1)]: ago(3 * DAY) });
  const none = await run(bucket, fakeInUse(), { deadline: NOW, clock: () => NOW });
  assert.equal(bucket.calls.list.length, 0);
  assert.match(none.notes.join(" "), /no time left/);
  let t = NOW;
  const later = await run(bucket, fakeInUse(), { deadline: NOW + 1, clock: () => t++ });
  assert.equal(later.removed, 0);
  assert.match(later.notes.join(" "), /ran out of time/);
});

test("the day's window of channel folders moves along, so every channel gets its turn", async () => {
  // Each channel keeps one sent file, so the folder list holds still.
  const files: Record<string, string> = {};
  const sent: string[] = [];
  for (let c = 0; c < 5; c++) {
    files[upload(c, 1)] = ago(3 * DAY);
    const kept = upload(c, 2);
    files[kept] = ago(3 * DAY);
    sent.push(kept);
  }
  const bucket = fakeBucket(files);
  for (let day = 0; day < 3; day++) {
    const report = await run(bucket, fakeInUse(sent), { limits: { channels: 2 }, now: NOW + day * DAY });
    assert.deepEqual(report.folders, { examined: 2, total: 5 });
    assert.match(report.notes.join(" "), /today's window: 2 of 5 channel folders/);
  }
  assert.deepEqual(sorted(bucket.objects.keys()), sorted(sent));
});

// ---------------------------------------------------------------------------
// The pure rules, and the wiring
// ---------------------------------------------------------------------------

test("triage and the verdict: layout, then age, then the database — and the verdict re-checks all three", () => {
  const old = upload(1, 1);
  const young = upload(1, 1);
  const foreign = `${channel(1)}/${person(1)}/x.png`;
  const files = [
    { path: old, createdAt: ago(2 * DAY), updatedAt: null },
    { path: young, createdAt: ago(HOUR), updatedAt: null },
    { path: foreign, createdAt: ago(2 * DAY), updatedAt: null },
    { path: upload(1, 1), createdAt: null, updatedAt: null },
  ];
  const t = triageChatFiles(files, NOW);
  assert.deepEqual(t.candidates.map((f) => f.path), [old]);
  assert.deepEqual([t.young, t.foreign, t.undated], [1, 1, 1]);
  assert.deepEqual(selectChatOrphans(files, new Set(), NOW), [old]);
  assert.deepEqual(selectChatOrphans(files, new Set([old]), NOW), []);
  assert.equal(isChatFolderName(channel(1)), true);
  assert.equal(isChatFolderName(channel(1).toUpperCase()), false);
  assert.equal(isChatUploadPath(old), true);
  assert.equal(isChatUploadPath(foreign), false);
});

test("the bounds are the ones the route's time budget was sized for", () => {
  assert.deepEqual({ ...CHAT_SWEEP_LIMITS }, { channels: 200, objects: 2000, removals: 500 });
});

test("this module imports nothing server-side, so node --test can run it", () => {
  const src = readFileSync(new URL("./chat-housekeeping.ts", import.meta.url), "utf8");
  const specifiers = [...src.matchAll(/^import[^;]*?from\s+"([^"]+)"/gm)].map((m) => m[1]);
  assert.ok(specifiers.length > 0);
  for (const spec of specifiers) assert.match(spec, /^\.\/[a-z0-9-]+\.ts$/);
  assert.doesNotMatch(src, /server-only|createAdminClient|@\/lib\//);
});

test("the cron is scheduled daily, fails closed, and asks chat_files_in_use", () => {
  const vercel = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));
  assert.deepEqual(
    vercel.crons.filter((c: { path: string }) => c.path === "/api/cron/chat-housekeeping"),
    [{ path: "/api/cron/chat-housekeeping", schedule: "30 13 * * *" }],
  );
  const route = readFileSync(new URL("../app/api/cron/chat-housekeeping/route.ts", import.meta.url), "utf8");
  assert.match(route, /if \(!env\.cronSecret\)/);
  assert.match(route, /Bearer \$\{env\.cronSecret\}/);
  assert.match(route, /sweepUnsentChatFiles\(/);
  assert.match(route, /rpc\("chat_files_in_use"/);
  const sql = readFileSync(new URL("../supabase/migrations/0101_chat.sql", import.meta.url), "utf8");
  assert.match(sql, /create or replace function public\.chat_files_in_use\(p_paths text\[\]\)/);
});

test("a sent message keeps the exact path its file was uploaded to", () => {
  // "In use" means attachments[].path === the object's key. If sending ever
  // stored a transformed path, every attachment would look unsent a day later.
  const src = readFileSync(new URL("./chat-files.ts", import.meta.url), "utf8");
  assert.match(src, /attachments\.push\(\{ path: f\.path,/);
});
