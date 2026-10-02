import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  LOOKUP_MAX_CHARS,
  LOOKUP_MAX_PATHS,
  MASS_DELETE_GUARD,
  ORPHAN_MIN_AGE_MS,
  SWEEP_LIMITS,
  chunk,
  chunkByPathLength,
  daysBefore,
  filesInListing,
  isMissingBucket,
  isPastStagingWindow,
  isSweepableFolder,
  lastWrittenAt,
  looksLikeLostRows,
  rotatingWindow,
  selectOrphans,
  sweepOrphanedAttachments,
  triageFiles,
  type FindRecorded,
  type ListedEntry,
  type StoredFile,
  type SweepStorage,
} from "./support-housekeeping.ts";
import {
  buildAttachmentPath,
  isWellFormedAttachmentPath,
  stagingPrefix,
  ticketPrefix,
} from "./support-attachment-rules.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
/** 09:00 in New York, when the cron runs (13:00 UTC). */
const NOW = Date.parse("2026-10-01T13:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

/** A lowercase uuid, distinct per n. */
function uuid(n: number): string {
  const hex = n.toString(16);
  return `${hex.padStart(8, "0")}-0000-4000-8000-${hex.padStart(12, "0")}`;
}

/** An id with hex letters in it, for the case tests (uuid(1) is all digits). */
const WITH_LETTERS = uuid(0xabcdef);

let objectSeq = 100_000;
const userId = (n: number) => uuid(n);
const ticketId = (n: number) => uuid(10_000 + n);
/** A path exactly as the mint action builds one for a request that doesn't exist yet. */
const staged = (user: number, name = "Screenshot 2026-09-30.png") =>
  buildAttachmentPath(stagingPrefix(userId(user)), uuid(++objectSeq), name);
/** … and for a follow-up, a token holder or staff, on a ticket. */
const onTicket = (ticket: number, name = "receipt.pdf") =>
  buildAttachmentPath(ticketPrefix(ticketId(ticket)), uuid(++objectSeq), name);
const userFolder = (n: number) => stagingPrefix(userId(n)).slice(0, -1);

type Stamp = { created_at: string | null; updated_at: string | null };

/**
 * An in-memory bucket that answers list() the way storage does: one level
 * deep, folders as entries with a null id, name order, limit/offset pages.
 */
function fakeBucket(initial: Record<string, string | Stamp> = {}) {
  const objects = new Map<string, Stamp>();
  const put = (path: string, at: string | Stamp) =>
    objects.set(path, typeof at === "string" ? { created_at: at, updated_at: at } : at);
  for (const [path, at] of Object.entries(initial)) put(path, at);

  const calls = {
    list: [] as { prefix: string; limit: number; offset: number }[],
    remove: [] as string[][],
  };
  const faults = {
    list: null as ((prefix: string, offset: number) => string | null) | null,
    remove: null as ((paths: string[]) => string | null) | null,
    afterList: null as ((prefix: string) => void) | null,
  };

  const storage: SweepStorage = {
    async list(prefix, page) {
      calls.list.push({ prefix, ...page });
      const fault = faults.list?.(prefix, page.offset);
      if (fault) return { data: null, error: { message: fault } };
      const base = `${prefix}/`;
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
      faults.afterList?.(prefix);
      return { data: entries.slice(page.offset, page.offset + page.limit), error: null };
    },
    async remove(paths) {
      calls.remove.push([...paths]);
      const fault = faults.remove?.(paths);
      if (fault) return { data: null, error: { message: fault } };
      const gone = paths.filter((p) => objects.delete(p));
      return { data: gone.map((name) => ({ name })), error: null };
    },
  };
  return { objects, put, storage, calls, faults };
}

/** support_ticket_attachments, as far as the sweep can see it: a set of storage paths. */
function fakeTable(rows: Iterable<string> = []) {
  const recorded = new Set(rows);
  const calls: string[][] = [];
  const faults = {
    read: null as ((paths: string[], call: number) => string | null) | null,
    afterRead: null as ((call: number) => void) | null,
  };
  const findRecorded: FindRecorded = async (paths) => {
    const call = calls.push([...paths]) - 1;
    const fault = faults.read?.(paths, call);
    if (fault) return { data: null, error: { message: fault } };
    const data = paths.filter((p) => recorded.has(p));
    faults.afterRead?.(call);
    return { data, error: null };
  };
  return { recorded, calls, faults, findRecorded };
}

type SweepArgs = Parameters<typeof sweepOrphanedAttachments>[0];

function sweep(
  bucket: ReturnType<typeof fakeBucket>,
  table: { findRecorded: FindRecorded },
  extra: Partial<SweepArgs> = {},
) {
  return sweepOrphanedAttachments({
    storage: bucket.storage,
    findRecorded: table.findRecorded,
    now: NOW,
    ...extra,
  });
}

const sorted = (xs: Iterable<string>) => [...xs].sort();
/** The guard off, for tests about something else that need lots of orphans. */
const NO_GUARD = { minOrphans: Number.POSITIVE_INFINITY };

// ---------------------------------------------------------------------------
// The sweep: what goes and what stays
// ---------------------------------------------------------------------------

test("deletes a file nobody attached once it's past a day, in staging and ticket folders alike", async () => {
  const orphanStaged = staged(1);
  const orphanOnTicket = onTicket(1);
  const attached = staged(1, "attached.png");
  const young = onTicket(1, "fresh.png");
  const bucket = fakeBucket({
    [orphanStaged]: ago(30 * HOUR),
    [orphanOnTicket]: ago(3 * DAY),
    [attached]: ago(10 * DAY),
    [young]: ago(2 * HOUR),
  });
  const table = fakeTable([attached]);

  const report = await sweep(bucket, table);

  assert.deepEqual(sorted(bucket.objects.keys()), sorted([attached, young]));
  assert.equal(report.removed, 2);
  assert.equal(report.examined, 4);
  assert.equal(report.skipped, 0);
  assert.equal(report.errors, 0);
  assert.equal(report.halted, false);
  assert.deepEqual(report.folders, { examined: 2, total: 2 });
});

test("recorded means a row for the exact path: a staged file keeps its u/ path once attached", async () => {
  const objectId = uuid(9001);
  const stagedPath = buildAttachmentPath(stagingPrefix(userId(2)), objectId, "invoice.pdf");
  const sameNameOnTicket = buildAttachmentPath(ticketPrefix(ticketId(2)), objectId, "invoice.pdf");

  // The row is the u/ path itself — recordAttachments never moves a file.
  const kept = fakeBucket({ [stagedPath]: ago(5 * DAY) });
  assert.equal((await sweep(kept, fakeTable([stagedPath]))).removed, 0);
  assert.ok(kept.objects.has(stagedPath));

  // A row for some other path with the same tail vouches for nothing.
  const gone = fakeBucket({ [stagedPath]: ago(5 * DAY) });
  assert.equal((await sweep(gone, fakeTable([sameNameOnTicket]))).removed, 1);
  assert.equal(gone.objects.size, 0);
});

test("never deletes anything a day old or younger, judged by its latest timestamp", async () => {
  const exactlyADay = staged(3, "exactly.png");
  const justOver = staged(3, "just-over.png");
  const reuploaded = staged(3, "reuploaded.png");
  const fromTheFuture = staged(3, "skewed.png");
  const bucket = fakeBucket({
    [exactlyADay]: ago(ORPHAN_MIN_AGE_MS),
    [justOver]: ago(ORPHAN_MIN_AGE_MS + 1),
    [reuploaded]: { created_at: ago(9 * DAY), updated_at: ago(HOUR) },
    [fromTheFuture]: new Date(NOW + HOUR).toISOString(),
  });

  const report = await sweep(bucket, fakeTable());

  assert.deepEqual(sorted(bucket.objects.keys()), sorted([exactlyADay, reuploaded, fromTheFuture]));
  assert.equal(report.removed, 1);
  // Young files were judged, not doubted.
  assert.equal(report.skipped, 0);
});

test("an object with no readable timestamp is never old", async () => {
  const undated = staged(4);
  const garbled = staged(4, "garbled.png");
  const bucket = fakeBucket({
    [undated]: { created_at: null, updated_at: null },
    [garbled]: { created_at: "last tuesday", updated_at: "" },
  });

  const report = await sweep(bucket, fakeTable());

  assert.equal(report.removed, 0);
  assert.equal(bucket.objects.size, 2);
  assert.equal(report.skipped, 2);
  assert.ok(report.notes.some((n) => /no readable timestamp/.test(n)));
});

test("touches nothing outside the path grammar, and never opens a folder the app didn't make", async () => {
  const folder = userFolder(5);
  const strays = [
    `${folder}/not-a-minted-name.png`, // no object uuid
    `${folder}/${uuid(77)}-Upper.png`, // the grammar is lowercase
    `${folder}/nested/${uuid(78)}-x.png`, // a folder inside a folder
    `u/at-the-top.png`, // a file where folders go
    `u/${WITH_LETTERS.toUpperCase()}/${uuid(79)}-x.png`, // an id the mint would have lowercased
    `t/not-a-ticket/${uuid(80)}-x.png`,
    `x/${uuid(81)}/${uuid(82)}-x.png`, // outside u/ and t/ altogether
  ];
  const bucket = fakeBucket(Object.fromEntries(strays.map((p) => [p, ago(10 * DAY)])));

  const report = await sweep(bucket, fakeTable());

  assert.equal(report.removed, 0);
  assert.equal(bucket.objects.size, strays.length);
  assert.equal(bucket.calls.remove.length, 0);
  // The two roots and the one folder that is a real staging folder. Not the
  // nested one, not the upper-case one, not t/not-a-ticket, never x/.
  assert.deepEqual(sorted(new Set(bucket.calls.list.map((c) => c.prefix))), sorted(["u", "t", folder]));
  // Three strays at the top (a file, two folders) and three inside `folder`.
  assert.equal(report.skipped, 6);
  assert.equal(report.examined, 6);
  assert.ok(report.notes.some((n) => /outside the u\/<id>\/… and t\/<id>\/… layout/.test(n)));
});

// ---------------------------------------------------------------------------
// The sweep: never on a doubt
// ---------------------------------------------------------------------------

test("a failed read of the table deletes nothing — an error is not 'no rows'", async () => {
  const paths = [staged(10), staged(10, "two.png"), onTicket(10)];
  const make = () => fakeBucket(Object.fromEntries(paths.map((p) => [p, ago(3 * DAY)])));

  const erroring = fakeTable();
  erroring.faults.read = () => "connection reset by peer";
  const throwing: FindRecorded = async () => {
    throw new Error("socket hang up");
  };
  // Success with no list in it is not an empty list either.
  const empty: FindRecorded = async () => ({ data: null, error: null });

  for (const findRecorded of [erroring.findRecorded, throwing, empty]) {
    const bucket = make();
    const report = await sweep(bucket, { findRecorded });
    assert.equal(report.removed, 0);
    assert.equal(bucket.objects.size, paths.length);
    assert.equal(bucket.calls.remove.length, 0);
    assert.equal(report.skipped, paths.length);
    assert.equal(report.errors, 1);
    assert.ok(report.notes.some((n) => /couldn't be read/.test(n)));
  }
});

test("a read that fails for one batch skips that batch only", async () => {
  const paths = [1, 2, 3].flatMap((u) => Array.from({ length: 20 }, () => staged(20 + u)));
  const bucket = fakeBucket(Object.fromEntries(paths.map((p) => [p, ago(2 * DAY)])));
  const table = fakeTable();
  table.faults.read = (_paths, call) => (call === 0 ? "statement timeout" : null);

  const report = await sweep(bucket, table);

  const firstBatch = table.calls[0];
  assert.ok(firstBatch.length > 0 && firstBatch.length < paths.length, "needs more than one batch");
  assert.deepEqual(sorted(bucket.objects.keys()), sorted(firstBatch));
  assert.equal(report.removed, paths.length - firstBatch.length);
  assert.equal(report.skipped, firstBatch.length);
  assert.equal(report.errors, 1);
});

test("the read that licenses a delete is fresh: a file attached mid-sweep is kept", async () => {
  const attachedMeanwhile = staged(11, "late.png");
  const abandoned = staged(11, "abandoned.png");
  const bucket = fakeBucket({ [attachedMeanwhile]: ago(2 * DAY), [abandoned]: ago(2 * DAY) });
  const table = fakeTable();
  // Someone sends the form between the survey and the delete.
  table.faults.afterRead = (call) => {
    if (call === 0) table.recorded.add(attachedMeanwhile);
  };

  const report = await sweep(bucket, table);

  assert.ok(bucket.objects.has(attachedMeanwhile));
  assert.ok(!bucket.objects.has(abandoned));
  assert.equal(report.removed, 1);
  assert.equal(report.skipped, 0);
  assert.equal(table.calls.length, 2, "asked once to survey and once right before deleting");
  assert.ok(report.notes.some((n) => /attached while the sweep ran/.test(n)));
});

test("a delete that fails is skipped, not counted as removed", async () => {
  const paths = [staged(12), onTicket(12)];
  const bucket = fakeBucket(Object.fromEntries(paths.map((p) => [p, ago(2 * DAY)])));
  bucket.faults.remove = () => "503 Service Unavailable";

  const report = await sweep(bucket, fakeTable());

  assert.equal(report.removed, 0);
  assert.equal(report.skipped, 2);
  assert.equal(report.errors, 1);
  assert.equal(bucket.objects.size, 2);
});

test("a root that can't be listed at all throws before anything is deleted; a missing bucket says so", async () => {
  const orphan = staged(13);
  const bucket = fakeBucket({ [orphan]: ago(3 * DAY) });
  bucket.faults.list = (prefix, offset) => (prefix === "t" && offset === 0 ? "Bucket not found" : null);

  await assert.rejects(sweep(bucket, fakeTable()), (err: Error) => {
    assert.match(err.message, /^listing t\/ failed: Bucket not found$/);
    assert.ok(isMissingBucket(err));
    return true;
  });
  assert.ok(bucket.objects.has(orphan));
  assert.equal(bucket.calls.remove.length, 0);
});

test("the mass-deletion guard: when most old files have no row, nothing is deleted", async () => {
  const orphans = [30, 31, 32].flatMap((u) => Array.from({ length: 20 }, () => staged(u)));
  const lostRows = fakeBucket(Object.fromEntries(orphans.map((p) => [p, ago(4 * DAY)])));

  const halted = await sweep(lostRows, fakeTable());

  assert.equal(halted.halted, true);
  assert.equal(halted.removed, 0);
  assert.equal(lostRows.objects.size, orphans.length);
  assert.equal(lostRows.calls.remove.length, 0);
  assert.equal(halted.skipped, orphans.length);
  assert.ok(halted.notes.some((n) => /nothing was deleted/.test(n)));

  // The same sixty orphans among the files people did attach: an ordinary day.
  const attached = [33, 34, 35, 36, 37].flatMap((u) => Array.from({ length: 60 }, () => onTicket(u)));
  const ordinary = fakeBucket(
    Object.fromEntries([...orphans, ...attached].map((p) => [p, ago(4 * DAY)])),
  );
  const swept = await sweep(ordinary, fakeTable(attached));
  assert.equal(swept.halted, false);
  assert.equal(swept.removed, orphans.length);
  assert.deepEqual(sorted(ordinary.objects.keys()), sorted(attached));
});

// ---------------------------------------------------------------------------
// The sweep: paging and bounds
// ---------------------------------------------------------------------------

test("pages through a folder longer than one page, and lists it whole before deleting", async () => {
  const files = Array.from({ length: 250 }, () => onTicket(40));
  const orphans = files.filter((_, i) => i % 25 === 0);
  const bucket = fakeBucket(Object.fromEntries(files.map((p) => [p, ago(2 * DAY)])));
  const folder = ticketPrefix(ticketId(40)).slice(0, -1);

  const report = await sweep(bucket, fakeTable(files.filter((p) => !orphans.includes(p))));

  assert.deepEqual(
    bucket.calls.list.filter((c) => c.prefix === folder).map((c) => c.offset),
    [0, 100, 200],
  );
  assert.equal(report.examined, 250);
  assert.equal(report.removed, orphans.length);
  assert.ok(orphans.every((p) => !bucket.objects.has(p)));
});

test("a listing that fails partway still has what it listed judged, and nothing past it", async () => {
  const files = Array.from({ length: 150 }, () => onTicket(41));
  const orphans = new Set(files.filter((_, i) => i % 5 === 0));
  const bucket = fakeBucket(Object.fromEntries(files.map((p) => [p, ago(2 * DAY)])));
  const folder = ticketPrefix(ticketId(41)).slice(0, -1);
  bucket.faults.list = (prefix, offset) => (prefix === folder && offset > 0 ? "upstream timeout" : null);

  const report = await sweep(bucket, fakeTable(files.filter((p) => !orphans.has(p))));

  const firstPage = new Set(sorted(files).slice(0, 100));
  const expectedGone = [...orphans].filter((p) => firstPage.has(p));
  assert.equal(report.examined, 100);
  assert.equal(report.errors, 1);
  assert.equal(report.removed, expectedGone.length);
  assert.ok(expectedGone.every((p) => !bucket.objects.has(p)));
  assert.ok([...orphans].filter((p) => !firstPage.has(p)).every((p) => bucket.objects.has(p)));
});

test("stops looking after the object budget", async () => {
  const paths = [50, 51, 52].flatMap((u) => Array.from({ length: 20 }, () => staged(u)));
  const bucket = fakeBucket(Object.fromEntries(paths.map((p) => [p, ago(2 * DAY)])));

  const report = await sweep(bucket, fakeTable(), { limits: { objects: 25 }, guard: NO_GUARD });

  assert.equal(report.examined, 25);
  assert.equal(report.folders.examined, 2);
  assert.equal(report.removed, 25);
  assert.equal(bucket.objects.size, paths.length - 25);
  // The second folder was asked for exactly what was left of the budget.
  assert.deepEqual(
    bucket.calls.list.filter((c) => c.prefix === userFolder(51)).map((c) => c.limit),
    [5],
  );
  assert.ok(report.notes.some((n) => /stopped after looking at 25 objects/.test(n)));
});

test("stops deleting at the removal budget", async () => {
  const paths = Array.from({ length: 10 }, () => staged(53));
  const bucket = fakeBucket(Object.fromEntries(paths.map((p) => [p, ago(2 * DAY)])));

  const report = await sweep(bucket, fakeTable(), { limits: { removals: 3 }, guard: NO_GUARD });

  assert.equal(report.removed, 3);
  assert.equal(report.skipped, 7);
  assert.equal(bucket.objects.size, 7);
  assert.ok(report.notes.some((n) => /stopped at 3 deletions/.test(n)));
});

test("stops opening folders once out of time, and starts nothing when already out", async () => {
  const paths = [60, 61, 62].map((u) => staged(u));
  const bucket = fakeBucket(Object.fromEntries(paths.map((p) => [p, ago(2 * DAY)])));
  let late = false;
  bucket.faults.afterList = (prefix) => {
    if (prefix.includes("/")) late = true; // the first folder has been listed
  };

  const report = await sweep(bucket, fakeTable(), {
    deadline: NOW + 1000,
    clock: () => (late ? NOW + 1000 : NOW),
  });

  assert.equal(report.folders.examined, 1);
  assert.equal(report.removed, 0);
  assert.equal(report.skipped, 1);
  assert.equal(bucket.objects.size, 3);
  assert.ok(report.notes.some((n) => /ran out of time/.test(n)));

  const idle = fakeBucket(Object.fromEntries(paths.map((p) => [p, ago(2 * DAY)])));
  const none = await sweep(idle, fakeTable(), { deadline: NOW, clock: () => NOW });
  assert.equal(idle.calls.list.length, 0);
  assert.equal(none.removed, 0);
});

test("the day's window of folders moves along, so every folder gets its turn", async () => {
  const users = [70, 71, 72, 73, 74];
  const orphans = users.map((u) => staged(u));
  // Each folder also holds an attached file, so none empties out of the listing.
  const attached = users.map((u) => staged(u, "kept.png"));
  const bucket = fakeBucket(
    Object.fromEntries([...orphans, ...attached].map((p) => [p, ago(3 * DAY)])),
  );
  const table = fakeTable(attached);

  for (let day = 0; day < 3; day++) {
    const report = await sweep(bucket, table, { now: NOW + day * DAY, limits: { folders: 2 } });
    assert.deepEqual(report.folders, { examined: 2, total: 5 });
  }

  assert.deepEqual(sorted(bucket.objects.keys()), sorted(attached));
});

test("asks the table about at most a hundred paths, and ~4,000 characters, at a time", async () => {
  const long = "a-rather-long-file-name-for-a-screenshot-of-the-billing-page-taken-at-night.png";
  const files = Array.from({ length: 250 }, () => onTicket(80, long));
  const orphans = files.slice(0, 5);
  const bucket = fakeBucket(Object.fromEntries(files.map((p) => [p, ago(2 * DAY)])));
  const table = fakeTable(files.slice(5));

  const report = await sweep(bucket, table);

  assert.equal(report.removed, orphans.length);
  assert.ok(table.calls.length > 1);
  for (const call of table.calls) {
    assert.ok(call.length <= LOOKUP_MAX_PATHS);
    assert.ok(call.reduce((n, p) => n + p.length, 0) <= LOOKUP_MAX_CHARS);
  }
});

// ---------------------------------------------------------------------------
// The pure rules
// ---------------------------------------------------------------------------

test("lastWrittenAt is the later readable timestamp; isPastStagingWindow is strictly over a day", () => {
  assert.equal(lastWrittenAt({ createdAt: ago(3 * DAY), updatedAt: ago(DAY) }), NOW - DAY);
  assert.equal(lastWrittenAt({ createdAt: ago(3 * DAY), updatedAt: null }), NOW - 3 * DAY);
  assert.equal(lastWrittenAt({ createdAt: "not a date", updatedAt: null }), null);
  assert.equal(lastWrittenAt({ createdAt: null, updatedAt: null }), null);

  const at = (ms: number) => ({ createdAt: ago(ms), updatedAt: null });
  assert.equal(isPastStagingWindow(at(DAY), NOW), false);
  assert.equal(isPastStagingWindow(at(DAY + 1), NOW), true);
  assert.equal(isPastStagingWindow(at(-HOUR), NOW), false);
  assert.equal(isPastStagingWindow({ createdAt: null, updatedAt: null }, NOW), false);
});

test("triageFiles and selectOrphans: grammar, then age, then the table — and the verdict re-checks all three", () => {
  const old = staged(90);
  const recorded = staged(90, "recorded.png");
  const young = staged(90, "young.png");
  const foreign = `${userFolder(90)}/not-ours.png`;
  const undated = staged(90, "undated.png");
  const files: StoredFile[] = [
    { path: old, createdAt: ago(2 * DAY), updatedAt: null },
    { path: recorded, createdAt: ago(2 * DAY), updatedAt: null },
    { path: young, createdAt: ago(HOUR), updatedAt: null },
    { path: foreign, createdAt: ago(9 * DAY), updatedAt: null },
    { path: undated, createdAt: null, updatedAt: null },
  ];

  const triage = triageFiles(files, NOW);
  assert.deepEqual(triage.candidates.map((f) => f.path), [old, recorded]);
  assert.deepEqual({ young: triage.young, foreign: triage.foreign, undated: triage.undated }, {
    young: 1,
    foreign: 1,
    undated: 1,
  });

  // Handed the whole untriaged list, the verdict still names only the old,
  // well-formed, unrecorded file — once, however often it's listed.
  assert.deepEqual(selectOrphans([...files, files[0]], new Set([recorded]), NOW), [old]);
  assert.deepEqual(selectOrphans(files, new Set([old, recorded]), NOW), []);
});

test("filesInListing builds full paths and counts nested folders instead of descending", () => {
  const entries: ListedEntry[] = [
    { name: `${uuid(1)}-a.png`, id: "1", created_at: ago(DAY), updated_at: ago(DAY) },
    { name: "nested", id: null, created_at: null, updated_at: null },
    { name: `${uuid(2)}-b.png`, id: "2" },
  ];
  const { files, nested } = filesInListing("t/x", entries);
  assert.equal(nested, 1);
  assert.deepEqual(files, [
    { path: `t/x/${uuid(1)}-a.png`, createdAt: ago(DAY), updatedAt: ago(DAY) },
    { path: `t/x/${uuid(2)}-b.png`, createdAt: null, updatedAt: null },
  ]);
});

test("isSweepableFolder: u/ or t/, a lowercase uuid, nothing else", () => {
  assert.equal(isSweepableFolder("u", userId(1)), true);
  assert.equal(isSweepableFolder("t", ticketId(1)), true);
  assert.equal(isSweepableFolder("u", WITH_LETTERS), true);
  assert.equal(isSweepableFolder("u", WITH_LETTERS.toUpperCase()), false);
  assert.equal(isSweepableFolder("x", userId(1)), false);
  assert.equal(isSweepableFolder("u", "not-a-uuid"), false);
  assert.equal(isSweepableFolder("u", ".emptyFolderPlaceholder"), false);
  // Every path the mint builds sits in a sweepable folder.
  for (const path of [staged(1), onTicket(1)]) {
    assert.ok(isWellFormedAttachmentPath(path));
    const [root, id] = path.split("/");
    assert.ok(isSweepableFolder(root, id));
  }
});

test("chunkByPathLength caps both the count and the characters, and never drops a path", () => {
  const items = Array.from({ length: 7 }, (_, i) => ({ path: "x".repeat(10 + i) }));
  const byCount = chunkByPathLength(items, 3, 10_000);
  assert.deepEqual(byCount.map((g) => g.length), [3, 3, 1]);
  const byChars = chunkByPathLength(items, 100, 25);
  assert.ok(byChars.every((g) => g.length === 1 || g.reduce((n, i) => n + i.path.length, 0) <= 25));
  assert.deepEqual(byChars.flat(), items);
  // A path longer than the budget still gets a group of its own.
  assert.equal(chunkByPathLength([{ path: "y".repeat(50) }], 100, 10).length, 1);
  assert.deepEqual(chunkByPathLength([], 100, 10), []);
});

test("rotatingWindow covers every item over consecutive days and is whole when it fits", () => {
  const items = Array.from({ length: 10 }, (_, i) => i);
  const seen = new Set<number>();
  for (let day = 0; day < Math.ceil(items.length / 3); day++) {
    const window = rotatingWindow(items, 3, NOW + day * DAY);
    assert.equal(window.length, 3);
    for (const i of window) seen.add(i);
  }
  assert.equal(seen.size, items.length);
  assert.notDeepEqual(rotatingWindow(items, 3, NOW), rotatingWindow(items, 3, NOW + DAY));
  assert.deepEqual(rotatingWindow(items, 3, NOW), rotatingWindow(items, 3, NOW + HOUR), "same day, same window");
  assert.deepEqual(rotatingWindow(items, 10, NOW), items);
  assert.deepEqual(rotatingWindow(items, 50, NOW), items);
  assert.deepEqual(rotatingWindow(items, 0, NOW), []);
  assert.deepEqual(rotatingWindow([], 3, NOW), []);
});

test("looksLikeLostRows needs both a real number of orphans and a lopsided share", () => {
  assert.deepEqual({ ...MASS_DELETE_GUARD }, { minOrphans: 50, maxShare: 0.8 });
  // Too few to matter, however lopsided.
  assert.equal(looksLikeLostRows(49, 49), false);
  assert.equal(looksLikeLostRows(50, 50), true);
  // 50 of 62 is more than 80%; 50 of 63 is not.
  assert.equal(looksLikeLostRows(50, 62), true);
  assert.equal(looksLikeLostRows(50, 63), false);
  // An ordinary day: a few orphans among many attachments.
  assert.equal(looksLikeLostRows(100, 1000), false);
  assert.equal(looksLikeLostRows(0, 0), false);
  // The thresholds are parameters, for the tests that need the guard out of the way.
  assert.equal(looksLikeLostRows(5, 5, { minOrphans: 5, maxShare: 0.5 }), true);
});

test("daysBefore, chunk and isMissingBucket", () => {
  assert.equal(daysBefore(NOW, 7), "2026-09-24T13:00:00.000Z");
  assert.equal(daysBefore(NOW, 14), "2026-09-17T13:00:00.000Z");
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunk([1, 2], 0), [[1], [2]]);
  assert.deepEqual(chunk([], 100), []);
  assert.equal(isMissingBucket({ message: "Bucket not found" }), true);
  assert.equal(isMissingBucket(new Error("listing u/ failed: Bucket not found")), true);
  assert.equal(isMissingBucket({ message: "Object not found" }), false);
  assert.equal(isMissingBucket(null), false);
});

test("the bounds are the ones the route's time budget was sized for", () => {
  // Raising these changes how long a run can take; re-check maxDuration and
  // SOFT_DEADLINE_MS in the route if you do.
  assert.deepEqual({ ...SWEEP_LIMITS }, { folders: 100, objects: 1000, removals: 300 });
  assert.equal(LOOKUP_MAX_PATHS, 100);
  assert.equal(ORPHAN_MIN_AGE_MS, DAY);
});

// ---------------------------------------------------------------------------
// The wiring
// ---------------------------------------------------------------------------

test("this module imports nothing server-side, so node --test can run it", () => {
  const src = readFileSync(new URL("./support-housekeeping.ts", import.meta.url), "utf8");
  const specifiers = [...src.matchAll(/^import[^;]*?from\s+"([^"]+)"/gm)].map((m) => m[1]);
  assert.ok(specifiers.length > 0);
  for (const spec of specifiers) assert.match(spec, /^\.\/[a-z0-9-]+\.ts$/);
  assert.doesNotMatch(src, /server-only|createAdminClient|@\/lib\//);
});

test("the cron is scheduled daily at 13:00 UTC, and the route fails closed", () => {
  const vercel = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));
  assert.deepEqual(
    vercel.crons.filter((c: { path: string }) => c.path === "/api/cron/support-housekeeping"),
    [{ path: "/api/cron/support-housekeeping", schedule: "0 13 * * *" }],
  );
  const route = readFileSync(
    new URL("../app/api/cron/support-housekeeping/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(route, /if \(!env\.cronSecret\)/);
  assert.match(route, /Bearer \$\{env\.cronSecret\}/);
  assert.match(route, /sweepOrphanedAttachments\(/);
});

test("a recorded row keeps the exact path the file was uploaded to", () => {
  // The sweep's whole idea of "recorded" is storage_path === the object's key.
  // If recordAttachments ever stores a path transformed in any way, every
  // attachment looks like an orphan a day later — change the sweep with it.
  const src = readFileSync(new URL("./support-attachments.ts", import.meta.url), "utf8");
  assert.match(src, /storage_path:\s*\w+\.path\b/);
});
