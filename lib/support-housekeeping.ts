/**
 * The daily support-housekeeping cron's decisions — and its sweep of orphaned
 * uploads, with the bucket and the attachments table handed in.
 *
 * Why the I/O is a parameter
 * --------------------------
 * app/api/cron/support-housekeeping/route.ts passes the real bucket and the
 * real support_ticket_attachments read; lib/support-housekeeping.test.ts
 * passes an in-memory bucket. That is the only way "never deletes a recorded
 * file", "a failed read deletes nothing" and "the second page of a folder is
 * still examined" get tested without a bucket to delete from — and those are
 * the claims that matter here, because a deleted object can't be brought
 * back. The same shape as lib/discord-auto-engine.ts and its fakes.
 *
 * So, like lib/support-attachment-rules.ts, this module imports nothing
 * server-side. Its one import is that module, by relative path with its
 * extension, so `node --test` runs it with no transpile step.
 *
 * What an orphan is
 * -----------------
 * Every attachment reaches the private bucket BEFORE the message it belongs
 * to exists (lib/support-attachment-rules.ts, steps 1–3): the browser puts the
 * bytes at a path the server built, and only when the form is sent does
 * recordAttachments write the row that makes the file part of a ticket. A file
 * removed from the picker, or picked in a form nobody sent, never gets that
 * row. It sits in the bucket for ever, unreachable — both download routes
 * authorize off the row — and costs storage for nothing.
 *
 * An object is deleted only when all three hold:
 *   1. its path is one the mint action builds — `u/<user id>/<uuid>-<name>`
 *      or `t/<ticket id>/<uuid>-<name>` (isWellFormedAttachmentPath) — so
 *      nothing the app didn't put there is ever judged;
 *   2. it was last written more than 24 hours ago. Someone can sit on a
 *      half-written request for an afternoon; a file deleted out from under an
 *      open form costs them a "That upload didn't finish. Attach it again." on
 *      send, which is recoverable, but not one they should meet the same day;
 *   3. no row in support_ticket_attachments has its exact path. A recorded
 *      file keeps the path it was uploaded to — a `u/…` path stays a `u/…`
 *      path — so a staging-folder file can perfectly well be an attachment.
 * And never on a doubt: a failed read of the table is not "no rows", an object
 * with no readable timestamp is not old, and a path the app didn't build is
 * not the app's to delete.
 */
import { isUuid, isWellFormedAttachmentPath } from "./support-attachment-rules.ts";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// ---------------------------------------------------------------------------
// The ticket steps
// ---------------------------------------------------------------------------

/** The instant `days` whole days before `now` — the `before` bound for listTicketsForHousekeeping. */
export function daysBefore(now: number, days: number): string {
  return new Date(now - days * DAY_MS).toISOString();
}

/** `items` in runs of at most `size` (at least one per run). */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const step = Math.max(1, Math.floor(size));
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += step) out.push(items.slice(i, i + step));
  return out;
}

/**
 * Storage's answer for a bucket that doesn't exist. Migration 0090 creates
 * `support-attachments` along with the tables, so this means the same thing
 * isMissingTable (lib/email/store) means for them: the SQL hasn't run here yet.
 */
export function isMissingBucket(error: { message?: string } | null | undefined): boolean {
  return Boolean(error?.message && /bucket not found/i.test(error.message));
}

// ---------------------------------------------------------------------------
// The orphan rules
// ---------------------------------------------------------------------------

/** How long an unrecorded upload is left alone. */
export const ORPHAN_MIN_AGE_MS = 24 * HOUR_MS;

/**
 * One entry of a storage `list()` page. A folder comes back as an entry with
 * a null id (and null timestamps); a file has an id.
 */
export type ListedEntry = {
  name: string;
  id: string | null;
  created_at?: string | null;
  updated_at?: string | null;
};

/** A file in the bucket, by its full path. */
export type StoredFile = {
  path: string;
  createdAt: string | null;
  updatedAt: string | null;
};

/**
 * When the object was last written, as far as storage says: the LATER of its
 * two timestamps. Re-uploading to a path keeps `created_at` and moves
 * `updated_at`; the mint action never re-uses a path, but if anything ever
 * did, the younger reading is the one that can't delete a fresh file. Null
 * when neither parses.
 */
export function lastWrittenAt(file: Pick<StoredFile, "createdAt" | "updatedAt">): number | null {
  let latest: number | null = null;
  for (const stamp of [file.createdAt, file.updatedAt]) {
    const at = typeof stamp === "string" ? Date.parse(stamp) : Number.NaN;
    if (Number.isFinite(at) && (latest === null || at > latest)) latest = at;
  }
  return latest;
}

/**
 * Strictly more than 24 hours since it was written. An age we can't read is
 * never old, and a timestamp in the future (clock skew) is young.
 */
export function isPastStagingWindow(
  file: Pick<StoredFile, "createdAt" | "updatedAt">,
  now: number,
): boolean {
  const at = lastWrittenAt(file);
  return at !== null && now - at > ORPHAN_MIN_AGE_MS;
}

/**
 * Is `<root>/<name>` a folder the mint action creates — `u/<user id>` or
 * `t/<ticket id>`, the id lowercased as stagingPrefix/ticketPrefix write it?
 * Anything else at the top of the bucket was put there by someone other than
 * the app, and the sweep doesn't open it.
 */
export function isSweepableFolder(root: string, name: string): boolean {
  return (root === "u" || root === "t") && isUuid(name) && name === name.toLowerCase();
}

/**
 * One folder's listing as files with full paths. Entries with a null id are
 * folders nested inside it — the mint action never makes one — so they are
 * counted, not descended into: list() is one level deep, and so is the sweep.
 */
export function filesInListing(
  folder: string,
  entries: readonly ListedEntry[],
): { files: StoredFile[]; nested: number } {
  const files: StoredFile[] = [];
  let nested = 0;
  for (const entry of entries) {
    if (entry.id == null) {
      nested++;
      continue;
    }
    files.push({
      path: `${folder}/${entry.name}`,
      createdAt: entry.created_at ?? null,
      updatedAt: entry.updated_at ?? null,
    });
  }
  return { files, nested };
}

export type Triage = {
  /** Well-formed and past the window: worth asking the table about. */
  candidates: StoredFile[];
  /** Inside the window. Left alone, and not a doubt — just not yet. */
  young: number;
  /** Not a path the app builds. Never judged. */
  foreign: number;
  /** No readable timestamp. Never judged old. */
  undated: number;
};

/** Rules 1 and 2. Rule 3 needs the table, so it's selectOrphans's. */
export function triageFiles(files: readonly StoredFile[], now: number): Triage {
  const out: Triage = { candidates: [], young: 0, foreign: 0, undated: 0 };
  for (const file of files) {
    if (!isWellFormedAttachmentPath(file.path)) out.foreign++;
    else if (lastWrittenAt(file) === null) out.undated++;
    else if (!isPastStagingWindow(file, now)) out.young++;
    else out.candidates.push(file);
  }
  return out;
}

/**
 * THE verdict: the paths to delete, given the paths the table says are
 * recorded. It re-applies all three rules rather than trusting that `files`
 * was triaged, so a caller that passes the wrong list still can't delete a
 * young file, a recorded one, or one the app didn't make.
 *
 * `recorded` must come from a read that SUCCEEDED. A failed read is not an
 * empty set, and the sweep never calls this with one.
 */
export function selectOrphans(
  files: readonly StoredFile[],
  recorded: ReadonlySet<string>,
  now: number,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    if (seen.has(file.path)) continue;
    seen.add(file.path);
    if (
      isWellFormedAttachmentPath(file.path) &&
      isPastStagingWindow(file, now) &&
      !recorded.has(file.path)
    ) {
      out.push(file.path);
    }
  }
  return out;
}

/**
 * Paths per `.in("storage_path", …)` read: at most a hundred, and at most
 * about 4,000 characters between them. The filter travels in the request URL,
 * each path percent-encodes a little longer than it is, and a hundred of the
 * longest the grammar allows would be ~18 KB — past what common proxies
 * accept in a request line. A refused read would only ever skip its batch
 * (never delete it), but a batch that is ALWAYS refused is a set of orphans
 * no run ever clears.
 */
export const LOOKUP_MAX_PATHS = 100;
export const LOOKUP_MAX_CHARS = 4000;

/** Groups of files whose paths fit one lookup (and one remove call). */
export function chunkByPathLength<T extends { path: string }>(
  items: readonly T[],
  maxCount: number = LOOKUP_MAX_PATHS,
  maxChars: number = LOOKUP_MAX_CHARS,
): T[][] {
  const out: T[][] = [];
  let current: T[] = [];
  let chars = 0;
  for (const item of items) {
    if (current.length > 0 && (current.length >= maxCount || chars + item.path.length > maxChars)) {
      out.push(current);
      current = [];
      chars = 0;
    }
    current.push(item);
    chars += item.path.length;
  }
  if (current.length > 0) out.push(current);
  return out;
}

/**
 * Which `size` of (sorted) `items` this run visits: a window that moves along
 * the list by `size` each UTC day, wrapping at the end. While the list holds
 * still, every item is visited at least once every ⌈n / size⌉ days.
 *
 * Starting from the top every day would be simpler and wrong: once the bucket
 * has more folders than one run may open, the first hundred (by name) would
 * be swept daily and an orphan in the hundred-and-first never.
 */
export function rotatingWindow<T>(items: readonly T[], size: number, now: number): T[] {
  const n = items.length;
  const take = Math.max(0, Math.floor(size));
  if (take >= n) return [...items];
  if (take === 0) return [];
  const day = Math.floor(now / DAY_MS);
  const start = (((day * take) % n) + n) % n;
  return Array.from({ length: take }, (_, i) => items[(start + i) % n]);
}

/**
 * The mass-deletion guard. When most of the old files a run could check have
 * no row, abandoned uploads are the unlikely explanation — people attach far
 * more than they abandon, and recorded files accumulate while orphans are
 * cleared daily. The likely ones are that rows were lost (the table emptied,
 * or restored to an earlier point) or that something changed how a path is
 * stored, so that no file matches its row any more. Either way every
 * attachment is about to look like an orphan, and deleting is the one
 * response that can't be undone. So the run deletes nothing, says so, and
 * answers `ok: false` until somebody has looked.
 *
 * Fifty, so a quiet bucket's ordinary day — a handful of picker removals
 * among a handful of files — can never trip it.
 */
export const MASS_DELETE_GUARD = { minOrphans: 50, maxShare: 0.8 } as const;

export type MassDeleteGuard = { minOrphans: number; maxShare: number };

export function looksLikeLostRows(
  orphans: number,
  checked: number,
  guard: MassDeleteGuard = MASS_DELETE_GUARD,
): boolean {
  return orphans >= guard.minOrphans && orphans > checked * guard.maxShare;
}

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

/**
 * What one run may do. Daily, so anything past a bound is simply tomorrow's:
 * the bounds keep a run's worst case — a hundred folder listings, a thousand
 * objects judged, a few dozen table reads and three hundred deletions — a
 * fraction of the function's time limit, whatever is in the bucket.
 */
export const SWEEP_LIMITS = {
  /** Folders whose contents one run lists. */
  folders: 100,
  /** Objects one run looks at. */
  objects: 1000,
  /** Objects one run deletes. */
  removals: 300,
} as const;

export type SweepLimits = { folders: number; objects: number; removals: number };

/** Just the shape of supabase-js answers the sweep relies on. */
type Answer<T> = { data: T | null; error: { message?: string } | null };

/** The two bucket operations the sweep uses, as storage-js `list` and `remove` answer them. */
export type SweepStorage = {
  /** One page of a one-level listing under `prefix` (no trailing slash). */
  list(prefix: string, page: { limit: number; offset: number }): Promise<Answer<ListedEntry[]>>;
  /** Deletes these exact paths; answers with the objects it deleted. */
  remove(paths: string[]): Promise<Answer<unknown[]>>;
};

/** Which of these paths have a support_ticket_attachments row — or an error. */
export type FindRecorded = (paths: string[]) => Promise<Answer<string[]>>;

export type OrphanSweepReport = {
  /** Entries looked at: every file in the folders visited, and any stray. */
  examined: number;
  /** Objects deleted. */
  removed: number;
  /**
   * Objects left alone without a verdict: outside the path grammar, no
   * readable timestamp, a read or delete that failed, the guard, or a budget
   * that ran out. Young and recorded files aren't counted — they were judged.
   */
  skipped: number;
  folders: { examined: number; total: number };
  /** Listings, table reads and deletes that failed. Each one deleted nothing. */
  errors: number;
  /** The mass-deletion guard stopped this run: nothing was deleted. */
  halted: boolean;
  notes: string[];
};

/** Folder names per page when finding the folders: names are short, so pages are big. */
const FOLDER_PAGE = 1000;
/** Objects per page inside one folder — storage's own default page. */
const FILE_PAGE = 100;
/** Folder names read per root before choosing the day's window. */
const MAX_FOLDER_NAMES = 20_000;
/** Staging folders, then ticket folders. Nothing outside these two is ever listed. */
const ROOTS = ["u", "t"] as const;

/**
 * Finds and deletes orphaned uploads, within `limits`, never past `deadline`.
 *
 * In four phases, so that nothing is deleted until everything is known:
 *  1. find the `u/<id>` and `t/<id>` folders, and take today's window of them;
 *  2. list each one and triage its files (rules 1 and 2);
 *  3. ask the table about every candidate (rule 3), and stop here if the
 *     answer looks like lost rows rather than abandoned uploads;
 *  4. delete — asking the table about each batch AGAIN right before deleting
 *     it, so the read that licenses a delete is one round trip old rather than
 *     one sweep old, and a file someone attached meanwhile is kept.
 *
 * Throws only when a root can't be listed at all (phase 1), which is before
 * anything is deleted. Everything later that fails is counted, noted and
 * skipped: an error never reads as "no rows", and never deletes.
 */
export async function sweepOrphanedAttachments(args: {
  storage: SweepStorage;
  findRecorded: FindRecorded;
  /** The moment ages are judged from. */
  now: number;
  /** Nothing new starts at or after this instant (epoch ms). */
  deadline?: number;
  clock?: () => number;
  limits?: Partial<SweepLimits>;
  guard?: Partial<MassDeleteGuard>;
}): Promise<OrphanSweepReport> {
  const limits: SweepLimits = { ...SWEEP_LIMITS, ...args.limits };
  const guard: MassDeleteGuard = { ...MASS_DELETE_GUARD, ...args.guard };
  const clock = args.clock ?? Date.now;
  const deadline = args.deadline ?? Number.POSITIVE_INFINITY;
  const outOfTime = () => clock() >= deadline;

  const report: OrphanSweepReport = {
    examined: 0,
    removed: 0,
    skipped: 0,
    folders: { examined: 0, total: 0 },
    errors: 0,
    halted: false,
    notes: [],
  };
  const tally = {
    strays: 0,
    undated: 0,
    listFailures: 0,
    lookupFailures: 0,
    removeFailures: 0,
    attachedMeanwhile: 0,
  };
  let stoppedBy: "time" | "objects" | "removals" | null = null;
  const stop = (why: "time" | "objects" | "removals") => {
    stoppedBy ??= why;
  };

  const finish = (): OrphanSweepReport => {
    report.skipped += tally.strays + tally.undated;
    report.errors = tally.listFailures + tally.lookupFailures + tally.removeFailures;
    const notes = report.notes;
    if (tally.strays > 0) {
      notes.push(`${count(tally.strays, "entry", "entries")} outside the u/<id>/… and t/<id>/… layout left alone`);
    }
    if (tally.undated > 0) {
      notes.push(`${count(tally.undated, "file", "files")} with no readable timestamp left alone`);
    }
    if (tally.listFailures > 0) {
      notes.push(`${count(tally.listFailures, "listing", "listings")} failed partway; whatever was listed was still checked`);
    }
    if (tally.lookupFailures > 0) {
      notes.push(`the attachments table couldn't be read ${count(tally.lookupFailures, "time", "times")}; those files were left for the next run`);
    }
    if (tally.removeFailures > 0) {
      notes.push(`${count(tally.removeFailures, "delete", "deletes")} failed; those files were left for the next run`);
    }
    if (tally.attachedMeanwhile > 0) {
      notes.push(`${count(tally.attachedMeanwhile, "file was", "files were")} attached while the sweep ran, and kept`);
    }
    if (stoppedBy === "time") notes.push("ran out of time; the rest waits for the next run");
    if (stoppedBy === "objects") notes.push(`stopped after looking at ${limits.objects} objects; the rest waits for the next run`);
    if (stoppedBy === "removals") notes.push(`stopped at ${limits.removals} deletions; the rest waits for the next run`);
    if (report.folders.total > limits.folders) {
      notes.push(`today's window: ${report.folders.examined} of ${report.folders.total} folders (it moves along daily)`);
    }
    return report;
  };

  if (outOfTime()) {
    report.notes.push("no time left in this run to sweep");
    return finish();
  }

  // 1. The folders, and today's share of them.
  const found = new Set<string>();
  for (const root of ROOTS) {
    for (const folder of await listFolders(args.storage, root, report, tally, outOfTime)) {
      found.add(folder);
    }
  }
  const folders = [...found].sort();
  report.folders.total = folders.length;

  // 2. List each folder in the window and triage what's in it.
  const candidates: StoredFile[] = [];
  for (const folder of rotatingWindow(folders, limits.folders, args.now)) {
    const room = limits.objects - report.examined;
    if (room <= 0) {
      stop("objects");
      break;
    }
    if (outOfTime()) {
      stop("time");
      break;
    }
    report.folders.examined++;
    const listing = await listFiles(args.storage, folder, room, outOfTime);
    if (listing.failed) tally.listFailures++;
    report.examined += listing.entries.length;
    const { files, nested } = filesInListing(folder, listing.entries);
    const triage = triageFiles(files, args.now);
    tally.strays += nested + triage.foreign;
    tally.undated += triage.undated;
    candidates.push(...triage.candidates);
    if (listing.cut === "time") {
      stop("time");
      break;
    }
    if (listing.cut === "room") {
      stop("objects");
      break;
    }
  }

  // 3. Ask the table about every candidate. A batch whose read fails is not
  //    "no rows": it is left out of everything that follows.
  const recorded = new Set<string>();
  const checked: StoredFile[] = [];
  for (const group of chunkByPathLength(candidates)) {
    if (outOfTime()) {
      stop("time");
      break;
    }
    const answer = await attemptList(() => args.findRecorded(group.map((f) => f.path)));
    if (answer.error !== null) {
      tally.lookupFailures++;
      continue;
    }
    for (const path of answer.data) if (typeof path === "string") recorded.add(path);
    checked.push(...group);
  }
  report.skipped += candidates.length - checked.length;
  const orphans = selectOrphans(checked, recorded, args.now);

  if (looksLikeLostRows(orphans.length, checked.length, guard)) {
    report.halted = true;
    report.skipped += orphans.length;
    report.notes.push(
      `${orphans.length} of the ${checked.length} files past 24 hours have no attachment row, ` +
        `which looks like lost rows rather than abandoned uploads, so nothing was deleted. ` +
        `Check support_ticket_attachments (was it emptied or restored? did the stored path format change?) ` +
        `before deleting anything by hand.`,
    );
    return finish();
  }

  // 4. Delete, within the budget, re-asking the table batch by batch.
  const allowed = new Set(orphans.slice(0, Math.max(0, limits.removals)));
  if (allowed.size < orphans.length) {
    report.skipped += orphans.length - allowed.size;
    stop("removals");
  }
  const groups = chunkByPathLength(checked.filter((f) => allowed.has(f.path)));
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];
    if (outOfTime()) {
      report.skipped += groups.slice(i).reduce((n, g) => n + g.length, 0);
      stop("time");
      break;
    }
    const fresh = await attemptList(() => args.findRecorded(group.map((f) => f.path)));
    if (fresh.error !== null) {
      tally.lookupFailures++;
      report.skipped += group.length;
      continue;
    }
    const doomed = selectOrphans(
      group,
      new Set(fresh.data.filter((p): p is string => typeof p === "string")),
      args.now,
    );
    tally.attachedMeanwhile += group.length - doomed.length;
    if (doomed.length === 0) continue;
    const removed = await attemptList(() => args.storage.remove(doomed));
    if (removed.error !== null) {
      tally.removeFailures++;
      report.skipped += doomed.length;
      continue;
    }
    // What storage says it deleted. A path already gone (an overlapping run
    // got there first) isn't in the answer, and isn't this run's deletion.
    report.removed += Math.min(removed.data.length, doomed.length);
  }

  return finish();
}

/**
 * The `<id>` folders under one root, in pages until an empty one — a short
 * page proves nothing if the server caps page sizes below what was asked.
 * Anything else at that level (a stray file, a folder that isn't a lowercase
 * uuid) is counted as a stray and never opened.
 *
 * Throws when the FIRST page fails: with nothing listed there is nothing to
 * go on, and the caller should hear it as a failure — or, for "Bucket not
 * found", as migration 0090 not applied.
 */
async function listFolders(
  storage: SweepStorage,
  root: string,
  report: OrphanSweepReport,
  tally: { strays: number; listFailures: number },
  outOfTime: () => boolean,
): Promise<string[]> {
  const folders: string[] = [];
  let offset = 0;
  while (offset < MAX_FOLDER_NAMES) {
    if (offset > 0 && outOfTime()) break;
    const page = await attemptList(() => storage.list(root, { limit: FOLDER_PAGE, offset }));
    if (page.error !== null) {
      if (offset === 0) throw new Error(`listing ${root}/ failed: ${page.error}`);
      tally.listFailures++;
      break;
    }
    if (page.data.length === 0) break;
    for (const entry of page.data) {
      if (entry.id == null && isSweepableFolder(root, entry.name)) {
        folders.push(`${root}/${entry.name}`);
      } else {
        tally.strays++;
        report.examined++;
      }
    }
    offset += page.data.length;
  }
  return folders;
}

/**
 * Up to `room` entries of one folder, a page at a time. The whole folder is
 * listed before anything in it is deleted: deleting between pages would shift
 * every later entry down and the next offset would skip them.
 *
 * A page that fails ends the listing, but what was already listed is still
 * returned and judged — each of those entries existed when it was listed, and
 * every one still has to pass the table check before it can be deleted.
 */
async function listFiles(
  storage: SweepStorage,
  folder: string,
  room: number,
  outOfTime: () => boolean,
): Promise<{ entries: ListedEntry[]; failed: boolean; cut: "time" | "room" | null }> {
  const entries: ListedEntry[] = [];
  const seen = new Set<string>();
  let offset = 0;
  while (entries.length < room) {
    if (offset > 0 && outOfTime()) return { entries, failed: false, cut: "time" };
    const limit = Math.min(FILE_PAGE, room - entries.length);
    const page = await attemptList(() => storage.list(folder, { limit, offset }));
    if (page.error !== null) return { entries, failed: true, cut: null };
    // A name already seen means an upload landed mid-listing and shifted the
    // pages by one; the entry has been counted once and that's enough.
    for (const entry of page.data.slice(0, limit)) {
      if (seen.has(entry.name)) continue;
      seen.add(entry.name);
      entries.push(entry);
    }
    offset += page.data.length;
    if (page.data.length < limit) return { entries, failed: false, cut: null };
  }
  return { entries, failed: false, cut: "room" };
}

/**
 * Runs one supabase-js call and settles it as a list or an error message.
 * A throw is an error, and so is an answer with no list in it — above all
 * from the attachments table, where "no rows" is what licenses a delete.
 */
async function attemptList<T>(
  run: () => Promise<Answer<T[]>>,
): Promise<{ data: T[]; error: null } | { data: null; error: string }> {
  try {
    const answer = await run();
    if (answer.error) return { data: null, error: answer.error.message || "unknown error" };
    if (!Array.isArray(answer.data)) return { data: null, error: "the answer had no list in it" };
    return { data: answer.data, error: null };
  } catch (err) {
    return { data: null, error: err instanceof Error ? err.message : String(err) };
  }
}

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}
