/**
 * The daily sweep of chat uploads nobody sent, with the bucket and the
 * "is this file in a message?" read handed in — so lib/chat-housekeeping.test.ts
 * runs it against an in-memory bucket, and the claims that matter (a file a
 * message points at is never deleted, a failed read deletes nothing) are
 * tested without a bucket to lose.
 *
 * Why there are orphans at all
 * ----------------------------
 * A chat attachment reaches the private `chat-files` bucket BEFORE its
 * message exists (lib/chat-files-rules.ts has the flow): the composer uploads
 * as soon as a file is picked, and only sending writes the message that
 * points at it. A file taken back out of the composer, or picked in a message
 * nobody sent, is never pointed at. Nobody can reach it (the files route
 * authorizes off the message), but it sits there, and someone who took a
 * photo back out reasonably expects it to be gone.
 *
 * Deleting a message doesn't make its files orphans: the message's
 * attachments move into chat_message_revisions (0101's revision trigger),
 * kept as evidence for reports, and a revision counts as pointing at them.
 * What does make them orphans: a group deleted when its last member leaves,
 * or a channel staff deleted — its messages go, and removeChannelFiles
 * (lib/chat-files.ts) is best effort. The sweep catches whatever that missed.
 *
 * An object is deleted only when all three hold:
 *   1. its path is one mintChatUploads builds —
 *      `<channel id>/<uploader id>/<uuid>-<name>` (parseChatUploadPath) — so
 *      nothing the app didn't put there is ever judged;
 *   2. it was last written more than 24 hours ago (support's window and
 *      reasoning: a file deleted out from under a draft costs a "didn't
 *      finish uploading. Attach it again." on send — recoverable, but not one
 *      to meet the same day);
 *   3. public.chat_files_in_use (0101) says no message and no kept revision
 *      points at its exact path.
 * And never on a doubt: a failed read is not "nobody", an object with no
 * readable timestamp is not old, and when most old files look unreferenced
 * the run assumes rows were lost and deletes nothing (support's guard).
 *
 * Like lib/support-housekeeping.ts, whose rules and helpers this reuses, it
 * imports nothing server-side, so `node --test` runs it as is.
 */
import { parseChatUploadPath } from "./chat-files-rules.ts";
import {
  MASS_DELETE_GUARD,
  chunkByPathLength,
  filesInListing,
  isPastStagingWindow,
  lastWrittenAt,
  looksLikeLostRows,
  rotatingWindow,
  type FindRecorded,
  type ListedEntry,
  type MassDeleteGuard,
  type OrphanSweepReport,
  type StoredFile,
  type SweepStorage,
} from "./support-housekeeping.ts";

export type { FindRecorded, ListedEntry, OrphanSweepReport, StoredFile, SweepStorage };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A folder name the mint action writes: a lowercase uuid (a channel at the top, an uploader inside it). */
export function isChatFolderName(name: string): boolean {
  return UUID_RE.test(name);
}

/** Rule 1, for a full path: exactly the shape chatUploadPath builds. */
export function isChatUploadPath(path: string): boolean {
  return parseChatUploadPath(path) !== null;
}

export type ChatTriage = {
  /** Well-formed and past the window: worth asking the database about. */
  candidates: StoredFile[];
  young: number;
  foreign: number;
  undated: number;
};

/** Rules 1 and 2. Rule 3 needs the database, so it's selectChatOrphans's. */
export function triageChatFiles(files: readonly StoredFile[], now: number): ChatTriage {
  const out: ChatTriage = { candidates: [], young: 0, foreign: 0, undated: 0 };
  for (const file of files) {
    if (!isChatUploadPath(file.path)) out.foreign++;
    else if (lastWrittenAt(file) === null) out.undated++;
    else if (!isPastStagingWindow(file, now)) out.young++;
    else out.candidates.push(file);
  }
  return out;
}

/**
 * THE verdict: what to delete, given the paths the database says are in use.
 * Re-applies all three rules instead of trusting that `files` was triaged.
 * `inUse` must come from a read that SUCCEEDED.
 */
export function selectChatOrphans(files: readonly StoredFile[], inUse: ReadonlySet<string>, now: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    if (seen.has(file.path)) continue;
    seen.add(file.path);
    if (isChatUploadPath(file.path) && isPastStagingWindow(file, now) && !inUse.has(file.path)) out.push(file.path);
  }
  return out;
}

/**
 * What one run may do. Channel folders are the unit of the daily window: a
 * DM is a channel, so there can be thousands, and a run opens a few hundred
 * of them, moving along a window a day.
 */
export const CHAT_SWEEP_LIMITS = {
  /** Channel folders one run opens. */
  channels: 200,
  /** Objects one run looks at. */
  objects: 2000,
  /** Objects one run deletes. */
  removals: 500,
} as const;

export type ChatSweepLimits = { channels: number; objects: number; removals: number };

/** Folder names per page at the top of the bucket: names are short, so pages are big. */
const FOLDER_PAGE = 1000;
/** Entries per page inside a folder: storage's own default. */
const FILE_PAGE = 100;
/** Channel folder names read before choosing the day's window. */
const MAX_CHANNEL_FOLDERS = 50_000;

type Settled<T> = { data: T[]; error: null } | { data: null; error: string };

/**
 * Finds and deletes unsent chat uploads, within `limits`, never past
 * `deadline`. Same four phases as support's sweep: find today's channel
 * folders; list and triage their files; ask the database about every
 * candidate and stop if the answer looks like lost rows; delete, re-asking
 * right before each batch so a file someone just attached is kept.
 *
 * Throws only when the top of the bucket can't be listed at all, which is
 * before anything is deleted. Everything later that fails is counted, noted
 * and skipped.
 */
export async function sweepUnsentChatFiles(args: {
  storage: SweepStorage;
  /** Which of these paths a message or a kept revision points at (chat_files_in_use). */
  findInUse: FindRecorded;
  now: number;
  deadline?: number;
  clock?: () => number;
  limits?: Partial<ChatSweepLimits>;
  guard?: Partial<MassDeleteGuard>;
}): Promise<OrphanSweepReport> {
  const limits: ChatSweepLimits = { ...CHAT_SWEEP_LIMITS, ...args.limits };
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
  const tally = { strays: 0, undated: 0, listFailures: 0, lookupFailures: 0, removeFailures: 0, attachedMeanwhile: 0 };
  let stoppedBy: "time" | "objects" | "removals" | null = null;
  const stop = (why: "time" | "objects" | "removals") => {
    stoppedBy ??= why;
  };

  const finish = (): OrphanSweepReport => {
    report.skipped += tally.strays + tally.undated;
    report.errors = tally.listFailures + tally.lookupFailures + tally.removeFailures;
    const notes = report.notes;
    if (tally.strays > 0) notes.push(`${count(tally.strays, "entry", "entries")} outside the <channel>/<uploader>/… layout left alone`);
    if (tally.undated > 0) notes.push(`${count(tally.undated, "file", "files")} with no readable timestamp left alone`);
    if (tally.listFailures > 0) notes.push(`${count(tally.listFailures, "listing", "listings")} failed; whatever was listed was still checked`);
    if (tally.lookupFailures > 0) {
      notes.push(`chat_files_in_use couldn't be read ${count(tally.lookupFailures, "time", "times")}; those files were left for the next run`);
    }
    if (tally.removeFailures > 0) notes.push(`${count(tally.removeFailures, "delete", "deletes")} failed; those files were left for the next run`);
    if (tally.attachedMeanwhile > 0) {
      notes.push(`${count(tally.attachedMeanwhile, "file was", "files were")} sent in a message while the sweep ran, and kept`);
    }
    if (stoppedBy === "time") notes.push("ran out of time; the rest waits for the next run");
    if (stoppedBy === "objects") notes.push(`stopped after looking at ${limits.objects} objects; the rest waits for the next run`);
    if (stoppedBy === "removals") notes.push(`stopped at ${limits.removals} deletions; the rest waits for the next run`);
    if (report.folders.total > limits.channels) {
      notes.push(`today's window: ${report.folders.examined} of ${report.folders.total} channel folders (it moves along daily)`);
    }
    return report;
  };

  if (outOfTime()) {
    report.notes.push("no time left in this run to sweep");
    return finish();
  }

  // 1. The channel folders at the top of the bucket, and today's share.
  const channels: string[] = [];
  for (let offset = 0; offset < MAX_CHANNEL_FOLDERS; ) {
    if (offset > 0 && outOfTime()) break;
    const page = await settle(() => args.storage.list("", { limit: FOLDER_PAGE, offset }));
    if (page.error !== null) {
      if (offset === 0) throw new Error(`listing the chat-files bucket failed: ${page.error}`);
      tally.listFailures++;
      break;
    }
    if (page.data.length === 0) break;
    for (const entry of page.data) {
      if (entry.id == null && isChatFolderName(entry.name)) channels.push(entry.name);
      else {
        tally.strays++;
        report.examined++;
      }
    }
    offset += page.data.length;
  }
  channels.sort();
  report.folders.total = channels.length;

  // 2. Each channel in the window: its uploader folders, then their files.
  const candidates: StoredFile[] = [];
  walk: for (const channel of rotatingWindow(channels, limits.channels, args.now)) {
    if (outOfTime()) {
      stop("time");
      break;
    }
    report.folders.examined++;
    const top = await listAll(args.storage, channel, Number.POSITIVE_INFINITY, outOfTime);
    if (top.failed) tally.listFailures++;
    const uploaders: string[] = [];
    for (const entry of top.entries) {
      if (entry.id == null && isChatFolderName(entry.name)) uploaders.push(`${channel}/${entry.name}`);
      else {
        tally.strays++;
        report.examined++;
      }
    }
    for (const folder of uploaders) {
      const room = limits.objects - report.examined;
      if (room <= 0) {
        stop("objects");
        break walk;
      }
      if (outOfTime()) {
        stop("time");
        break walk;
      }
      const listing = await listAll(args.storage, folder, room, outOfTime);
      if (listing.failed) tally.listFailures++;
      report.examined += listing.entries.length;
      const { files, nested } = filesInListing(folder, listing.entries);
      const triage = triageChatFiles(files, args.now);
      tally.strays += nested + triage.foreign;
      tally.undated += triage.undated;
      candidates.push(...triage.candidates);
      if (listing.cut === "time") {
        stop("time");
        break walk;
      }
      if (listing.cut === "room") {
        stop("objects");
        break walk;
      }
    }
  }

  // 3. Ask the database about every candidate. A batch whose read fails is
  //    not "nobody": it's left out of everything that follows.
  const inUse = new Set<string>();
  const checked: StoredFile[] = [];
  for (const group of chunkByPathLength(candidates)) {
    if (outOfTime()) {
      stop("time");
      break;
    }
    const answer = await settle(() => args.findInUse(group.map((f) => f.path)));
    if (answer.error !== null) {
      tally.lookupFailures++;
      continue;
    }
    for (const path of answer.data) if (typeof path === "string") inUse.add(path);
    checked.push(...group);
  }
  report.skipped += candidates.length - checked.length;
  const orphans = selectChatOrphans(checked, inUse, args.now);

  if (looksLikeLostRows(orphans.length, checked.length, guard)) {
    report.halted = true;
    report.skipped += orphans.length;
    report.notes.push(
      `${orphans.length} of the ${checked.length} chat files past 24 hours aren't in any message or revision, ` +
        `which looks like lost rows rather than unsent uploads, so nothing was deleted. ` +
        `Check chat_messages and chat_message_revisions (emptied? restored? attachment paths stored differently?) ` +
        `before deleting anything by hand.`,
    );
    return finish();
  }

  // 4. Delete, within the budget, re-asking the database batch by batch.
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
    const fresh = await settle(() => args.findInUse(group.map((f) => f.path)));
    if (fresh.error !== null) {
      tally.lookupFailures++;
      report.skipped += group.length;
      continue;
    }
    const doomed = selectChatOrphans(group, new Set(fresh.data.filter((p): p is string => typeof p === "string")), args.now);
    tally.attachedMeanwhile += group.length - doomed.length;
    if (doomed.length === 0) continue;
    const removed = await settle(() => args.storage.remove(doomed));
    if (removed.error !== null) {
      tally.removeFailures++;
      report.skipped += doomed.length;
      continue;
    }
    report.removed += Math.min(removed.data.length, doomed.length);
  }

  return finish();
}

/**
 * Up to `room` entries of one folder, a page at a time, listed whole before
 * anything in it is deleted (deleting between pages would shift the offsets).
 * A failed page ends the listing; what was listed is still returned.
 */
async function listAll(
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
    const page = await settle(() => storage.list(folder, { limit, offset }));
    if (page.error !== null) return { entries, failed: true, cut: null };
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

/** One storage or database call as a list or an error: a throw, or an answer with no list, is an error. */
async function settle<T>(run: () => Promise<{ data: T[] | null; error: { message?: string } | null }>): Promise<Settled<T>> {
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
