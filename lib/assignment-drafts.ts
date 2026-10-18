/**
 * Private, autosaved assignment drafts — pure rules, shared by the server
 * action, the assignment pages and the form (lib/assignment-drafts.test.ts).
 *
 * A draft is what a student has typed and not yet submitted
 * (`course_assignment_drafts`, migration 0105). It is never a submission:
 * nothing staff see reads it, and Submit stays the one explicit way to hand
 * work in. Every save names the version it was typed on top of, so a tab left
 * open on an older copy is told it's stale instead of overwriting newer text.
 */
import { LIMITS, normalizeLink } from "./assignments.ts";

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
};

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
 */
export function checkDraft(input: {
  body?: string | null;
  link?: string | null;
}): { ok: true; body: string | null; link: string | null } | { ok: false; error: string } {
  const body = typeof input.body === "string" ? input.body : "";
  const link = typeof input.link === "string" ? input.link : "";
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
 * which moves when a reviewer returns the work.
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
  if (!d) return fromSubmission;
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
