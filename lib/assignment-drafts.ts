/**
 * Private, autosaved assignment drafts — pure rules, shared by the server
 * action, the assignment pages and the form (lib/assignment-drafts.test.ts).
 *
 * A draft is what a student has typed and not yet submitted
 * (`course_assignment_drafts`, migration 0105). It is never a submission:
 * nothing staff see reads it, and Submit stays the one explicit way to hand
 * work in. Every save names the version it was typed on top of, so a tab left
 * open on an older copy is told it's stale instead of overwriting newer text.
 * The version only ever goes up: a submit empties the row (`cleared_at`)
 * rather than deleting it, so an old number can never match a newer draft.
 *
 * Saves go over a plain route (app/api/assignments/[id]/draft), not a server
 * action, so a save sent as the page closes is a keepalive request the
 * browser finishes after the page is gone, and a signed-out session is a 401
 * the form can name rather than a redirect it can't tell from an outage.
 */
import { LIMITS, normalizeLink, storableText } from "./assignments.ts";

/** Quiet time after the last keystroke before a save. */
export const DRAFT_SAVE_DELAY_MS = 2000;
/** Someone typing without a pause still gets a save this often. */
export const DRAFT_MAX_WAIT_MS = 10_000;

/** A draft row as the pages read it. */
export type DraftRow = {
  body: string | null;
  link_url: string | null;
  version: number;
  updated_at: string;
  /** Set when a submit cleared it: no draft, though the version still counts. */
  cleared_at?: string | null;
};

/** The submission as the form compares against it. */
export type SubmissionSnapshot = {
  body: string | null;
  link_url: string | null;
  submitted_at: string | null;
};

/** What GET /api/assignments/<id>/draft answers: the draft and submission as they stand now. */
export type DraftState =
  | { state: "ready"; draft: DraftRow | null; submission: SubmissionSnapshot | null }
  | { state: "not_ready" };

/** What the pages pass the form: whether drafts work here, and the row if any. */
export type DraftLoad =
  | { state: "ready"; row: DraftRow | null }
  /** 0105 hasn't run: the form behaves as it did before drafts. */
  | { state: "not_ready" }
  /** The read failed for another reason: autosave is off for this visit. */
  | { state: "failed" };

/** Why a save didn't happen. */
export type DraftFailure =
  | "stale"
  | "closed"
  | "forbidden"
  | "locked"
  | "signed_out"
  | "not_ready"
  | "too_long"
  | "rate_limited"
  | "error";

const DRAFT_FAILURES: readonly DraftFailure[] = [
  "stale",
  "closed",
  "forbidden",
  "locked",
  "signed_out",
  "not_ready",
  "too_long",
  "rate_limited",
  "error",
];

export type DraftSaveResult =
  | { ok: true; version: number; savedAt: string }
  | { ok: false; reason: DraftFailure; version?: number | null };

/**
 * Failures the next save can't fix. The form stops autosaving on these rather
 * than retrying: another save would be refused the same way, and showing
 * "retrying" forever would be a lie. The rest retry with a backoff.
 */
export function isFinalDraftFailure(reason: DraftFailure): boolean {
  return reason !== "rate_limited" && reason !== "error";
}

/** 3s, 6s, 12s… capped at 30s. Rate-limited waits the cap. */
export function draftRetryDelay(attempt: number, reason: DraftFailure = "error"): number {
  if (reason === "rate_limited") return 30_000;
  return Math.min(30_000, 3_000 * 2 ** Math.max(0, attempt));
}

/**
 * Lengths only: a draft is whatever has been typed so far, valid or not (a
 * half-typed link is normal). Kept as typed, untrimmed; empty becomes null.
 * Less any NUL character (storableText), which Postgres can't store: one
 * used to fail every save, and the form retried it forever.
 */
export function checkDraft(input: {
  body?: string | null;
  link?: string | null;
}): { ok: true; body: string | null; link: string | null } | { ok: false; error: string } {
  const body = storableText(typeof input.body === "string" ? input.body : "");
  const link = storableText(typeof input.link === "string" ? input.link : "");
  if (body.length > LIMITS.body) return { ok: false, error: `Keep it under ${LIMITS.body} characters.` };
  if (link.length > LIMITS.link) return { ok: false, error: "That link is too long." };
  return { ok: true, body: body || null, link: link || null };
}

/** save_course_assignment_draft()'s jsonb → a result. Anything unexpected is an error. */
export function interpretDraftSave(data: unknown): DraftSaveResult {
  const r = (data && typeof data === "object" ? data : {}) as {
    outcome?: unknown;
    version?: unknown;
    saved_at?: unknown;
  };
  const version = typeof r.version === "number" && Number.isInteger(r.version) ? r.version : null;
  switch (r.outcome) {
    case "saved":
      if (version === null || typeof r.saved_at !== "string") return { ok: false, reason: "error" };
      return { ok: true, version, savedAt: r.saved_at };
    case "stale":
      return { ok: false, reason: "stale", version };
    case "closed":
    case "forbidden":
    case "locked":
      return { ok: false, reason: r.outcome };
    default:
      return { ok: false, reason: "error" };
  }
}

const isVersion = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

/**
 * The draft route's answer to a save → a result. 401 is the one way to be
 * told "signed out" (the route says it only when Auth rejected the session,
 * not when Auth was unreachable); any other non-200, or a body that isn't
 * the route's (a proxy's error page), is an error worth retrying.
 */
export function parseDraftSaveResponse(status: number, data: unknown): DraftSaveResult {
  if (status === 401) return { ok: false, reason: "signed_out" };
  if (status !== 200 || !data || typeof data !== "object") return { ok: false, reason: "error" };
  const r = data as { ok?: unknown; version?: unknown; savedAt?: unknown; reason?: unknown };
  if (r.ok === true) {
    return isVersion(r.version) && r.version > 0 && typeof r.savedAt === "string"
      ? { ok: true, version: r.version, savedAt: r.savedAt }
      : { ok: false, reason: "error" };
  }
  if (r.ok === false && DRAFT_FAILURES.includes(r.reason as DraftFailure)) {
    const out: { ok: false; reason: DraftFailure; version?: number | null } = {
      ok: false,
      reason: r.reason as DraftFailure,
    };
    if (r.version === null || isVersion(r.version)) out.version = r.version;
    return out;
  }
  return { ok: false, reason: "error" };
}

/** The draft route's answer to a read → the state, or null when it couldn't say. */
export function parseDraftStateResponse(status: number, data: unknown): DraftState | null {
  if (status !== 200 || !data || typeof data !== "object") return null;
  const r = data as { state?: unknown; draft?: unknown; submission?: unknown };
  if (r.state === "not_ready") return { state: "not_ready" };
  if (r.state !== "ready") return null;
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  let draft: DraftRow | null = null;
  if (r.draft) {
    const d = r.draft as Record<string, unknown>;
    if (!isVersion(d.version) || d.version < 1 || typeof d.updated_at !== "string") return null;
    draft = {
      body: str(d.body),
      link_url: str(d.link_url),
      version: d.version,
      updated_at: d.updated_at,
      cleared_at: str(d.cleared_at),
    };
  }
  let submission: SubmissionSnapshot | null = null;
  if (r.submission) {
    const sub = r.submission as Record<string, unknown>;
    submission = { body: str(sub.body), link_url: str(sub.link_url), submitted_at: str(sub.submitted_at) };
  }
  return { state: "ready", draft, submission };
}

/**
 * Whether a failed Auth check means the session is gone (sign in again) or
 * only that Auth couldn't answer (retry). supabase-js returns, rather than
 * throws, both: a 401/403 or a missing session is the first; a network
 * failure or a 5xx is the second, and calling that "signed out" would stop
 * autosave for the rest of the visit over one dropped request. The same rule
 * as app/apply/actions.ts.
 */
export function authRejectedSession(error: unknown): boolean {
  if (!error || typeof error !== "object") return true;
  const e = error as { status?: unknown; name?: unknown };
  return e.status === 401 || e.status === 403 || e.name === "AuthSessionMissingError";
}

type Work = { body: string | null | undefined; link: string | null | undefined };

/** A link the way submitAssignment would store it, so "https://x.co" and "https://x.co/" agree. */
function storedLink(raw: string | null | undefined): string {
  const n = normalizeLink(raw);
  return n.ok ? (n.url ?? "") : (raw ?? "").trim();
}

/**
 * The two say the same thing once submitAssignment has trimmed and normalised
 * them. `b` null is "nothing handed in", which only empty work matches.
 */
export function sameWork(a: Work, b: Work | null): boolean {
  const bodyA = (a.body ?? "").trim();
  const linkA = storedLink(a.link);
  if (!b) return !bodyA && !linkA;
  return bodyA === (b.body ?? "").trim() && linkA === storedLink(b.link);
}

export type StartingWork = {
  body: string;
  link: string;
  /**
   * The draft row's version, 0 when there is none: what the next save names.
   * Kept even when the draft isn't shown, so the first save replaces it
   * instead of being refused as stale.
   */
  version: number;
  /** When the draft now in the form was saved; null when it shows the submission. */
  restoredAt: string | null;
  /** The form starts on text that differs from what was handed in. */
  unsubmitted: boolean;
};

/**
 * What the form opens with. A draft wins when it was saved after the last
 * submit — unsubmitted edits on top of handed-in work, or work never handed in.
 * One saved before the last submit was overtaken by it (submitted from another
 * tab that didn't know about it, say): the submission is what the student last
 * chose, so it shows instead. Compared with submitted_at, not updated_at,
 * which moves when a reviewer returns the work. A cleared draft is no draft.
 */
export function startingWork(args: {
  submission: { body: string | null; link_url: string | null; submitted_at: string | null } | null;
  draft: DraftRow | null;
}): StartingWork {
  const { submission: s, draft: d } = args;
  const version = d && Number.isInteger(d.version) && d.version > 0 ? d.version : 0;
  const fromSubmission: StartingWork = {
    body: s?.body ?? "",
    link: s?.link_url ?? "",
    version,
    restoredAt: null,
    unsubmitted: false,
  };
  // A cleared row is what a submit left behind: the submission is the text.
  if (!d || d.cleared_at) return fromSubmission;
  const draftAt = Date.parse(d.updated_at);
  const submittedAt = s?.submitted_at ? Date.parse(s.submitted_at) : NaN;
  if (s && Number.isFinite(submittedAt) && !(draftAt > submittedAt)) return fromSubmission;
  const work = { body: d.body ?? "", link: d.link_url ?? "" };
  const unsubmitted = !sameWork(work, s ? { body: s.body, link: s.link_url } : null);
  // A draft that says what was handed in (or nothing, with nothing handed
  // in) restores nothing worth announcing.
  if (!unsubmitted) return { ...fromSubmission, ...work };
  return { ...work, version, restoredAt: d.updated_at, unsubmitted };
}

/** The form's text as a save sends it: the link is "" on a text-only assignment. */
export type SentWork = { body: string; link: string };

/** How many unanswered saves a tab remembers before it starts forgetting the middle ones. */
export const UNCONFIRMED_MAX = 50;

/**
 * A save got no answer (`error`): remember what it sent, alongside every
 * other unanswered save since the tab's last confirmed version. All of them
 * named that same version, so at most one can have landed, but which isn't
 * known: on a flaky phone the save that landed is often the first (its
 * answer lost as the connection went), and the retries after it never left.
 * Keeping only the latest one forgot it, so the stale answer that followed
 * read the tab's own save as another device's. Kept bounded for a long
 * offline stretch; the first is kept when the middle goes, for that reason.
 */
export function withUnconfirmed(list: readonly SentWork[], sent: SentWork): SentWork[] {
  if (list.some((w) => w.body === sent.body && w.link === sent.link)) return [...list];
  const next = [...list, sent];
  return next.length > UNCONFIRMED_MAX ? [next[0], ...next.slice(-(UNCONFIRMED_MAX - 1))] : next;
}

export type Reconciled =
  /** The server is where this tab thinks it is. */
  | { kind: "current" }
  /**
   * It moved on, to text this tab sent: the form's own text, or a save whose
   * answer was lost. Build on it — `text` is now what the server holds.
   */
  | { kind: "landed"; version: number; savedAt: string; text: SentWork }
  /** A submit from this tab whose answer was lost went through. */
  | { kind: "submitted"; version: number }
  /** It moved on and this tab has no edits of its own: show the newer text. */
  | { kind: "adopt"; start: StartingWork; handedIn: SentWork | null }
  /** It moved on, and this tab has edits that would overwrite it. */
  | { kind: "conflict"; version: number };

/**
 * Bring a tab up to date with the draft as it stands now.
 *
 * The page's props can be old. Next's Back/Forward restores the page from the
 * router cache — the payload from the first visit — so a student who typed a
 * paragraph, followed a link and pressed Back gets the form as it was before
 * they typed: empty, at the old version. And a save or submit can land without
 * its answer arriving (a dropped connection), leaving the tab a version behind
 * its own write. The form reads the draft again on mount and on a "stale"
 * answer, and this decides what to do:
 *
 *   - a submit of ours that got no answer, and the submission now says
 *     exactly that → it went through;
 *   - the draft hasn't moved past this tab → nothing to do;
 *   - it moved on to text this tab sent (now, or in any save since its last
 *     confirmed version that got no answer) → take its version and carry on;
 *   - this tab hasn't typed anything since it last synced (Back) → show the
 *     newer text;
 *   - otherwise this tab's edits would overwrite newer work → conflict, the
 *     student's call.
 */
export function reconcileDraft(
  local: {
    version: number;
    base: SentWork;
    work: SentWork;
    /** Every save since `version` that got no answer (withUnconfirmed): any one may have landed. */
    unconfirmed?: readonly SentWork[];
    pendingSubmit?: SentWork | null;
  },
  remote: { draft: DraftRow | null; submission: SubmissionSnapshot | null },
): Reconciled {
  const d = remote.draft;
  const s = remote.submission;
  const version = d && Number.isInteger(d.version) && d.version > 0 ? d.version : 0;
  if (
    local.pendingSubmit &&
    s &&
    sameWork(local.pendingSubmit, { body: s.body, link: s.link_url }) &&
    (!d || d.cleared_at || version <= local.version)
  ) {
    return { kind: "submitted", version: d?.cleared_at ? version : local.version };
  }
  if (version <= local.version) return { kind: "current" };
  if (d && !d.cleared_at) {
    const text = { body: d.body ?? "", link: d.link_url ?? "" };
    for (const mine of [local.work, ...(local.unconfirmed ?? [])]) {
      if (mine.body === text.body && mine.link === text.link) {
        return { kind: "landed", version, savedAt: d.updated_at, text };
      }
    }
  }
  if (local.work.body === local.base.body && local.work.link === local.base.link) {
    return {
      kind: "adopt",
      start: startingWork({ submission: s, draft: d }),
      handedIn: s ? { body: s.body ?? "", link: s.link_url ?? "" } : null,
    };
  }
  return { kind: "conflict", version };
}

/**
 * What a tab told "stale" learns from reading the draft back (reconcileDraft,
 * or null when the read failed):
 *
 *   - "synced": the newer version was this tab's own (a save, or a submit,
 *     whose answer was lost), or the tab had nothing to lose and took the
 *     newer text. It now holds the current version: carry on, or send the
 *     submit again — no question to ask.
 *   - "conflict": newer work from somewhere else that this tab's edits would
 *     replace. Only this is worth "changed in another tab or on another
 *     device".
 *   - "unread": the read failed, or the server and the read disagree about
 *     whether anything moved. Nothing is known: retry, never accuse.
 *
 * `afterSubmit` is a submit asking: replacing the text the student just
 * tried to hand in with another tab's is no answer, so "adopt" is a conflict.
 */
export function staleVerdict(r: Reconciled | null, afterSubmit = false): "synced" | "conflict" | "unread" {
  if (!r) return "unread";
  switch (r.kind) {
    case "landed":
    case "submitted":
      return "synced";
    case "adopt":
      return afterSubmit ? "conflict" : "synced";
    case "current":
      return "unread";
    case "conflict":
      return "conflict";
  }
}

/** submitAssignment's answer when it ran (the ActionResult's data). */
export type SubmitOutcome =
  | { outcome: "submitted"; draftVersion: number }
  /**
   * Nothing was handed in: since this tab last saved, newer text was saved,
   * or another one was submitted, in another tab or on another device. Ask,
   * then send again with `force`.
   */
  | { outcome: "stale" };

/**
 * Whether a submit would hand in over text this tab never saw, and how far
 * the draft it leaves behind may be cleared.
 *
 * `known` is the draft version the submitting tab last saved or loaded (null:
 * autosave isn't running there, so there's nothing to compare — the form
 * behaves as it did before drafts). A draft that has moved past it was saved
 * from somewhere else — unless it holds exactly the text being submitted, or
 * is a clear whose submission is this text (the same submit, sent again after
 * its answer was lost); neither is overwriting anything. `force` is the
 * student having been asked and said yes. Clearing goes up to the newest
 * version this submit accounts for, so a draft saved after it is left alone.
 */
export function submitConflict(args: {
  known: number | null;
  draft: DraftRow | null;
  submission: SubmissionSnapshot | null;
  input: SentWork;
  force?: boolean;
}): { stale: boolean; upTo: number } {
  if (args.known === null) return { stale: false, upTo: 0 };
  const known = Math.max(0, args.known);
  const d = args.draft;
  const current = d && d.version > 0 ? d.version : 0;
  if (current <= known) return { stale: false, upTo: known };
  const same = d!.cleared_at
    ? !!args.submission && sameWork(args.input, { body: args.submission.body, link: args.submission.link_url })
    : sameWork(args.input, { body: d!.body, link: d!.link_url });
  if (args.force || same) return { stale: false, upTo: current };
  return { stale: true, upTo: known };
}

/** What the small line under the form says. */
export type DraftStatus =
  | { kind: "off" }
  | { kind: "idle" }
  | { kind: "restored"; at: string }
  | { kind: "saving" }
  | { kind: "saved"; at: string }
  | { kind: "retrying"; reason: DraftFailure; offline?: boolean }
  | { kind: "stopped"; reason: DraftFailure }
  | { kind: "load_failed" };

export type DraftStatusLine = { text: string; tone: "muted" | "bad" } | null;

/**
 * The status line's words. `formatTime` renders a timestamp; `handedIn` is
 * whether a submission exists, `unsubmitted` whether the text in the form
 * differs from it (or there is none and the form isn't empty).
 */
export function draftStatusLine(
  status: DraftStatus,
  ctx: { handedIn: boolean; unsubmitted: boolean; formatTime: (iso: string) => string },
): DraftStatusLine {
  const pending = ctx.handedIn
    ? "Not submitted — reviewers see your last submission until you update it."
    : "Not submitted yet.";
  switch (status.kind) {
    case "off":
      return null;
    case "idle":
      return { text: "Your draft saves as you type. Only you can see it until you submit.", tone: "muted" };
    case "restored":
      return {
        text: `Restored your draft from ${ctx.formatTime(status.at)}. ${pending}`,
        tone: "muted",
      };
    case "saving":
      return { text: "Saving draft…", tone: "muted" };
    case "saved":
      return {
        text: ctx.unsubmitted
          ? `Draft saved ${ctx.formatTime(status.at)}. ${pending}`
          : `Draft saved ${ctx.formatTime(status.at)}.`,
        tone: "muted",
      };
    case "retrying":
      if (status.reason === "rate_limited") {
        return { text: "Saving is paused for a moment — your draft will save shortly.", tone: "bad" };
      }
      return {
        text: status.offline
          ? "You seem to be offline, so your draft isn't saved. It will save when you reconnect — keep this page open."
          : "Couldn't save your draft — retrying. Keep this page open until it saves.",
        tone: "bad",
      };
    case "stopped":
      return { text: stoppedText(status.reason), tone: "bad" };
    case "load_failed":
      return {
        text: "Couldn't load your saved draft, so autosave is off for this visit. Reload to try again, or submit to save your work.",
        tone: "bad",
      };
  }
}

function stoppedText(reason: DraftFailure): string {
  switch (reason) {
    case "stale":
      return "Not saving: this answer was changed in another tab or on another device. Reload to get the newer version — copy anything here you want to keep first.";
    case "closed":
      return "Draft saving stopped: this assignment isn't open any more.";
    case "forbidden":
      return "Draft saving stopped: this assignment isn't available to you any more.";
    case "locked":
      return "Draft saving stopped: this work has been reviewed, so it can't change.";
    case "signed_out":
      return "You've been signed out, so your draft isn't saving. Copy your text, sign in again, then reload.";
    case "not_ready":
      return "Drafts aren't set up yet, so this isn't saving. Submit to save your work.";
    case "too_long":
      return `Too long to save — keep it under ${LIMITS.body} characters.`;
    default:
      return "Draft saving stopped. Reload to try again.";
  }
}
