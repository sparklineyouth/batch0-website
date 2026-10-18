import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  authRejectedSession,
  checkDraft,
  draftRetryDelay,
  draftStatusLine,
  interpretDraftSave,
  isFinalDraftFailure,
  parseDraftSaveResponse,
  parseDraftStateResponse,
  reconcileDraft,
  sameWork,
  startingWork,
  submitConflict,
  type DraftFailure,
  type DraftRow,
} from "./assignment-drafts.ts";

// Run with `npm test`. The SQL half (versions, access, privacy) is
// lib/assignment-drafts-migration-db.test.ts.

const at = (iso: string) => iso;

test("a draft is kept as typed; only the lengths are checked", () => {
  assert.deepEqual(checkDraft({ body: "  half a thought\n", link: "https://docs.goo" }), {
    ok: true,
    body: "  half a thought\n",
    link: "https://docs.goo",
  });
  assert.deepEqual(checkDraft({ body: "", link: "" }), { ok: true, body: null, link: null });
  assert.deepEqual(checkDraft({}), { ok: true, body: null, link: null });
  assert.equal(checkDraft({ body: "x".repeat(10000) }).ok, true);
  assert.equal(checkDraft({ body: "x".repeat(10001) }).ok, false);
  assert.equal(checkDraft({ link: `https://x.co/${"y".repeat(2040)}` }).ok, false);
  // Not strings (a forged action call): treated as empty, not stored as junk.
  assert.deepEqual(checkDraft({ body: 42 as any, link: {} as any }), { ok: true, body: null, link: null });
});

test("the saver's answers", () => {
  assert.deepEqual(interpretDraftSave({ outcome: "saved", version: 3, saved_at: "2026-10-17T15:00:00Z" }), {
    ok: true,
    version: 3,
    savedAt: "2026-10-17T15:00:00Z",
  });
  assert.deepEqual(interpretDraftSave({ outcome: "stale", version: 4, saved_at: "x" }), { ok: false, reason: "stale", version: 4 });
  assert.deepEqual(interpretDraftSave({ outcome: "stale", version: null }), { ok: false, reason: "stale", version: null });
  for (const r of ["closed", "forbidden", "locked"] as const) {
    assert.deepEqual(interpretDraftSave({ outcome: r }), { ok: false, reason: r });
  }
  assert.deepEqual(interpretDraftSave({ outcome: "saved" }), { ok: false, reason: "error" });
  assert.deepEqual(interpretDraftSave(null), { ok: false, reason: "error" });
  assert.deepEqual(interpretDraftSave("saved"), { ok: false, reason: "error" });
});

test("autosave stops on refusals it can't fix and retries the rest", () => {
  const final: DraftFailure[] = ["stale", "closed", "forbidden", "locked", "signed_out", "not_ready", "too_long"];
  for (const r of final) assert.equal(isFinalDraftFailure(r), true, r);
  assert.equal(isFinalDraftFailure("error"), false);
  assert.equal(isFinalDraftFailure("rate_limited"), false);
  assert.deepEqual([0, 1, 2, 3, 4, 9].map((n) => draftRetryDelay(n)), [3000, 6000, 12000, 24000, 30000, 30000]);
  assert.equal(draftRetryDelay(0, "rate_limited"), 30000);
});

test("the same work once trimmed and normalised the way a submission is stored", () => {
  assert.equal(sameWork({ body: "answer\n", link: "https://docs.google.com" }, { body: "answer", link: "https://docs.google.com/" }), true);
  assert.equal(sameWork({ body: "answer, edited", link: "" }, { body: "answer", link: null }), false);
  assert.equal(sameWork({ body: "", link: "https://a.co/x" }, { body: null, link: "https://a.co/y" }), false);
  assert.equal(sameWork({ body: "  ", link: "" }, null), true);
  assert.equal(sameWork({ body: "something", link: "" }, null), false);
  // A half-typed link compares as typed.
  assert.equal(sameWork({ body: "", link: "https://docs.goo" }, { body: "", link: "https://docs.goo" }), true);
});

const SUBMITTED = { body: "handed in", link_url: null, submitted_at: "2026-10-17T15:00:00Z" };

test("reload: a draft restores, and a newer draft wins over the submission", () => {
  // Never handed in.
  assert.deepEqual(
    startingWork({ submission: null, draft: { body: "draft", link_url: "https://docs.goo", version: 4, updated_at: at("2026-10-17T14:00:00Z") } }),
    { body: "draft", link: "https://docs.goo", version: 4, restoredAt: "2026-10-17T14:00:00Z", unsubmitted: true },
  );
  // Edited after handing in: the edits, flagged as not submitted.
  assert.deepEqual(
    startingWork({ submission: SUBMITTED, draft: { body: "handed in, improved", link_url: null, version: 2, updated_at: at("2026-10-17T16:00:00Z") } }),
    { body: "handed in, improved", link: "", version: 2, restoredAt: "2026-10-17T16:00:00Z", unsubmitted: true },
  );
});

test("reload: a draft the last submit overtook shows the submission, but keeps its version", () => {
  const s = startingWork({
    submission: SUBMITTED,
    draft: { body: "older text from another tab", link_url: null, version: 6, updated_at: at("2026-10-17T14:59:59Z") },
  });
  assert.deepEqual(s, { body: "handed in", link: "", version: 6, restoredAt: null, unsubmitted: false });
  // Same second: the submit is the later act.
  assert.equal(
    startingWork({ submission: SUBMITTED, draft: { body: "x", link_url: null, version: 1, updated_at: SUBMITTED.submitted_at } }).body,
    "handed in",
  );
});

test("reload: a draft identical to the submission (or empty) announces nothing", () => {
  assert.deepEqual(
    startingWork({ submission: SUBMITTED, draft: { body: "handed in\n", link_url: null, version: 3, updated_at: at("2026-10-17T16:00:00Z") } }),
    { body: "handed in\n", link: "", version: 3, restoredAt: null, unsubmitted: false },
  );
  assert.deepEqual(
    startingWork({ submission: null, draft: { body: null, link_url: null, version: 2, updated_at: at("2026-10-17T16:00:00Z") } }),
    { body: "", link: "", version: 2, restoredAt: null, unsubmitted: false },
  );
  assert.deepEqual(startingWork({ submission: null, draft: null }), { body: "", link: "", version: 0, restoredAt: null, unsubmitted: false });
  // Returned for changes: submitted_at is unchanged by the review, so the
  // student's in-progress fix still wins.
  assert.equal(
    startingWork({
      submission: { ...SUBMITTED, submitted_at: "2026-10-17T15:00:00Z" },
      draft: { body: "the fix", link_url: null, version: 1, updated_at: at("2026-10-17T15:30:00Z") },
    }).body,
    "the fix",
  );
});

test("the status line says what's true", () => {
  const ctx = { handedIn: false, unsubmitted: true, formatTime: (iso: string) => `[${iso}]` };
  const text = (s: Parameters<typeof draftStatusLine>[0], c = ctx) => draftStatusLine(s, c)?.text ?? null;
  assert.equal(draftStatusLine({ kind: "off" }, ctx), null);
  assert.match(text({ kind: "idle" })!, /saves as you type\. Only you can see it/);
  assert.equal(text({ kind: "restored", at: "T" }), "Restored your draft from [T]. Not submitted yet.");
  assert.match(text({ kind: "restored", at: "T" }, { ...ctx, handedIn: true })!, /reviewers see your last submission/);
  assert.equal(text({ kind: "saving" }), "Saving draft…");
  assert.equal(text({ kind: "saved", at: "T" }), "Draft saved [T]. Not submitted yet.");
  assert.equal(text({ kind: "saved", at: "T" }, { ...ctx, handedIn: true, unsubmitted: false }), "Draft saved [T].");
  // Failures are never dressed up as saved.
  const bad = (s: Parameters<typeof draftStatusLine>[0]) => draftStatusLine(s, ctx)!;
  assert.equal(bad({ kind: "retrying", reason: "error" }).tone, "bad");
  assert.match(bad({ kind: "retrying", reason: "error" }).text, /Couldn't save your draft/);
  assert.match(bad({ kind: "retrying", reason: "error", offline: true }).text, /offline/);
  assert.match(bad({ kind: "retrying", reason: "rate_limited" }).text, /paused/);
  assert.match(bad({ kind: "stopped", reason: "stale" }).text, /changed in another tab.*Reload/);
  assert.match(bad({ kind: "stopped", reason: "forbidden" }).text, /isn't available to you any more/);
  assert.match(bad({ kind: "stopped", reason: "closed" }).text, /isn't open any more/);
  assert.match(bad({ kind: "stopped", reason: "locked" }).text, /reviewed/);
  assert.match(bad({ kind: "stopped", reason: "signed_out" }).text, /signed out/);
  assert.match(bad({ kind: "load_failed" }).text, /autosave is off/);
  for (const s of [
    { kind: "retrying", reason: "error" },
    { kind: "stopped", reason: "stale" },
    { kind: "load_failed" },
  ] as const) {
    assert.doesNotMatch(bad(s).text, /Draft saved/);
  }
});

test("drafts stay out of everything staff see", () => {
  // The submissions the staff surfaces read are a different table, and the
  // only readers of the drafts table are the student's own page and route.
  for (const p of [
    "lib/assignments-server.ts",
    "app/admin/assignments/actions.ts",
    "app/mentor/assignments/actions.ts",
    "app/api/cron/assignment-reminders/route.ts",
    "lib/progress.ts",
  ]) {
    const src = readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
    const uses = src.match(/course_assignment_drafts/g) ?? [];
    assert.equal(uses.length, p === "lib/assignments-server.ts" ? 1 : 0, p);
  }
  const server = readFileSync(new URL("../lib/assignments-server.ts", import.meta.url), "utf8");
  assert.match(server, /export async function loadAssignmentDraft\(db: Db, userId: string, assignmentId: string\)/);
  // Code only: the comments say what it doesn't do.
  const saver = readFileSync(new URL("../lib/assignment-drafts-server.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  // Autosave never writes a submission, bells anyone, or redirects.
  assert.doesNotMatch(saver, /course_assignment_submissions|notify|revalidatePath|redirect\(/);
  assert.match(saver, /rpc\("save_course_assignment_draft"/);
  const actions = readFileSync(new URL("../app/dashboard/assignments/actions.ts", import.meta.url), "utf8");
  // Submitting empties the draft (never deletes it, which would restart its
  // version) and only up to what this submit accounted for.
  assert.doesNotMatch(actions, /\.delete\(\)/);
  assert.match(actions, /rpc\("clear_course_assignment_draft"/);
  assert.match(actions, /p_up_to_version: conflict\.upTo/);
  assert.match(actions, /if \(conflict\.stale\) return \{ outcome: "stale" as const \};/);
  // The stale check runs before the submission is written.
  assert.ok(actions.indexOf("conflict.stale") < actions.indexOf('from("course_assignment_submissions").upsert('));
});

test("the draft route: same-origin writes, the user from the session, 401 only for a rejected session", () => {
  const route = readFileSync(new URL("../app/api/assignments/[id]/draft/route.ts", import.meta.url), "utf8");
  assert.match(route, /if \(!sameOrigin\(req\)\)/);
  assert.match(route, /const who = await draftAuthor\(\);/);
  assert.match(route, /who\.code === "signed_out"[\s\S]*?401\)[\s\S]*?503\)/);
  assert.match(route, /saveDraftAs\(who\.userId, \{\s*assignmentId: id,/);
  assert.match(route, /private, no-store/);
  // Reads through the student's own client (the owner-only policy decides).
  assert.match(route, /loadAssignmentDraft\(supabase, user\.id, id\)/);
  assert.doesNotMatch(route, /createAdminClient/);
  // /api isn't behind middleware's sign-in redirect, which turned a signed-out
  // server-action save into an unreadable response.
  const mw = readFileSync(new URL("../lib/supabase/middleware.ts", import.meta.url), "utf8");
  const protectedBlock = mw.slice(mw.indexOf("const protectedPath ="), mw.indexOf("const authPath ="));
  assert.doesNotMatch(protectedBlock, /"\/api/);
  const server = readFileSync(new URL("../lib/assignment-drafts-server.ts", import.meta.url), "utf8");
  assert.match(server, /if \(authRejectedSession\(error\)\) return \{ code: "signed_out" \};/);
});

test("signed out means Auth rejected the session — not that Auth was unreachable", () => {
  assert.equal(authRejectedSession({ name: "AuthSessionMissingError", status: 400 }), true);
  assert.equal(authRejectedSession({ name: "AuthApiError", status: 401 }), true);
  assert.equal(authRejectedSession({ name: "AuthApiError", status: 403 }), true);
  assert.equal(authRejectedSession(null), true);
  // A network failure or a GoTrue 5xx is retried, not reported as a sign-out.
  assert.equal(authRejectedSession({ name: "AuthRetryableFetchError", status: 0 }), false);
  assert.equal(authRejectedSession({ name: "AuthRetryableFetchError", status: 503 }), false);
  assert.equal(authRejectedSession({ name: "AuthUnknownError" }), false);
});

test("the route's answers, as the form reads them", () => {
  assert.deepEqual(parseDraftSaveResponse(200, { ok: true, version: 3, savedAt: "T" }), { ok: true, version: 3, savedAt: "T" });
  assert.deepEqual(parseDraftSaveResponse(200, { ok: false, reason: "stale", version: 4 }), { ok: false, reason: "stale", version: 4 });
  assert.deepEqual(parseDraftSaveResponse(200, { ok: false, reason: "forbidden" }), { ok: false, reason: "forbidden" });
  assert.deepEqual(parseDraftSaveResponse(401, { ok: false, reason: "signed_out" }), { ok: false, reason: "signed_out" });
  // 401 is signed out whatever the body; anything else unexpected retries.
  assert.deepEqual(parseDraftSaveResponse(401, null), { ok: false, reason: "signed_out" });
  assert.deepEqual(parseDraftSaveResponse(503, { ok: false, reason: "error" }), { ok: false, reason: "error" });
  assert.deepEqual(parseDraftSaveResponse(502, "<html>Bad gateway</html>"), { ok: false, reason: "error" });
  assert.deepEqual(parseDraftSaveResponse(200, { ok: true, version: 0, savedAt: "T" }), { ok: false, reason: "error" });
  assert.deepEqual(parseDraftSaveResponse(200, { ok: false, reason: "made_up" }), { ok: false, reason: "error" });
  // A 200 can't say "signed_out" is anything but what it says, either.
  assert.deepEqual(parseDraftSaveResponse(200, { ok: false, reason: "signed_out" }), { ok: false, reason: "signed_out" });

  const row = { body: "b", link_url: null, version: 2, updated_at: "T", cleared_at: null };
  assert.deepEqual(parseDraftStateResponse(200, { state: "ready", draft: row, submission: null }), {
    state: "ready",
    draft: row,
    submission: null,
  });
  assert.deepEqual(parseDraftStateResponse(200, { state: "not_ready" }), { state: "not_ready" });
  assert.equal(parseDraftStateResponse(503, { error: "unavailable" }), null);
  assert.equal(parseDraftStateResponse(200, { state: "ready", draft: { version: "2" } }), null);
  assert.equal(parseDraftStateResponse(200, null), null);
});

const row = (r: Partial<DraftRow>): DraftRow => ({
  body: null,
  link_url: null,
  version: 1,
  updated_at: "2026-10-17T16:00:00Z",
  cleared_at: null,
  ...r,
});

test("reload after a submit: a cleared draft shows the submission and keeps counting", () => {
  assert.deepEqual(
    startingWork({ submission: SUBMITTED, draft: row({ version: 7, updated_at: "2026-10-17T15:00:01Z", cleared_at: "2026-10-17T15:00:01Z" }) }),
    { body: "handed in", link: "", version: 7, restoredAt: null, unsubmitted: false },
  );
});

test("Back shows the first visit's copy: the form takes the newer draft if nothing was typed", () => {
  const empty = { body: "", link: "" };
  // Opened with no draft, typed a paragraph (saved as v2), left, pressed Back.
  const back = reconcileDraft(
    { version: 0, base: empty, work: empty },
    { draft: row({ body: "a paragraph", version: 2 }), submission: null },
  );
  assert.equal(back.kind, "adopt");
  assert.deepEqual(back.kind === "adopt" && back.start, {
    body: "a paragraph",
    link: "",
    version: 2,
    restoredAt: "2026-10-17T16:00:00Z",
    unsubmitted: true,
  });
  // Typed already in this copy: that's a conflict for the student, never a silent overwrite.
  assert.deepEqual(
    reconcileDraft(
      { version: 0, base: empty, work: { body: "new words", link: "" } },
      { draft: row({ body: "a paragraph", version: 2 }), submission: null },
    ),
    { kind: "conflict", version: 2 },
  );
  // Submitted elsewhere since: the cleared draft means the submission is the text.
  const submitted = reconcileDraft(
    { version: 2, base: { body: "a paragraph", link: "" }, work: { body: "a paragraph", link: "" } },
    { draft: row({ version: 3, cleared_at: "2026-10-17T16:01:00Z" }), submission: { ...SUBMITTED, body: "a paragraph" } },
  );
  assert.equal(submitted.kind === "adopt" && submitted.start.body, "a paragraph");
  assert.deepEqual(submitted.kind === "adopt" && submitted.handedIn, { body: "a paragraph", link: "" });
  // Fresh page: nothing to do.
  assert.deepEqual(
    reconcileDraft({ version: 2, base: empty, work: empty }, { draft: row({ version: 2 }), submission: null }),
    { kind: "current" },
  );
});

test("a save or submit whose answer was lost is recognised, not reported as another tab", () => {
  const base = { body: "draft", link: "" };
  // A save of "draft, more" landed as v4 without an answer; the tab kept typing.
  assert.deepEqual(
    reconcileDraft(
      { version: 3, base, work: { body: "draft, more, and more", link: "" }, unconfirmed: { body: "draft, more", link: "" } },
      { draft: row({ body: "draft, more", version: 4, updated_at: "T4" }), submission: null },
    ),
    { kind: "landed", version: 4, savedAt: "T4", text: { body: "draft, more", link: "" } },
  );
  // …or holds exactly what the form shows.
  assert.equal(
    reconcileDraft(
      { version: 3, base, work: { body: "draft, more", link: "" } },
      { draft: row({ body: "draft, more", version: 4 }), submission: null },
    ).kind,
    "landed",
  );
  // A submit with no answer: the draft was cleared for exactly this text.
  assert.deepEqual(
    reconcileDraft(
      { version: 3, base, work: base, pendingSubmit: { body: "draft", link: "" } },
      { draft: row({ version: 4, cleared_at: "C" }), submission: { ...SUBMITTED, body: "draft" } },
    ),
    { kind: "submitted", version: 4 },
  );
  // With no draft to clear, the submission saying exactly this is enough.
  assert.deepEqual(
    reconcileDraft(
      { version: 0, base: { body: "", link: "" }, work: base, pendingSubmit: base },
      { draft: null, submission: { ...SUBMITTED, body: "draft" } },
    ),
    { kind: "submitted", version: 0 },
  );
  // A different submission isn't ours.
  assert.notEqual(
    reconcileDraft(
      { version: 3, base, work: { body: "edited", link: "" }, pendingSubmit: { body: "edited", link: "" } },
      { draft: row({ version: 4, cleared_at: "C" }), submission: { ...SUBMITTED, body: "from the phone" } },
    ).kind,
    "submitted",
  );
});

test("Submit from a tab that's behind is refused unless it's the same text or the student says so", () => {
  const input = { body: "laptop text", link: "" };
  // No autosave in that tab: nothing to compare, nothing cleared.
  assert.deepEqual(submitConflict({ known: null, draft: row({ version: 9 }), submission: null, input }), { stale: false, upTo: 0 });
  // In step.
  assert.deepEqual(submitConflict({ known: 3, draft: row({ version: 3 }), submission: null, input }), { stale: false, upTo: 3 });
  assert.deepEqual(submitConflict({ known: 0, draft: null, submission: null, input }), { stale: false, upTo: 0 });
  // The phone saved v4 since: stale…
  assert.deepEqual(
    submitConflict({ known: 3, draft: row({ version: 4, body: "phone text" }), submission: null, input }),
    { stale: true, upTo: 3 },
  );
  // …or submitted it (cleared, v5).
  assert.deepEqual(
    submitConflict({ known: 3, draft: row({ version: 5, cleared_at: "C" }), submission: { ...SUBMITTED, body: "phone text" }, input }),
    { stale: true, upTo: 3 },
  );
  // Asked and confirmed: hand it in and clear up to what it overrode.
  assert.deepEqual(
    submitConflict({ known: 3, draft: row({ version: 4, body: "phone text" }), submission: null, input, force: true }),
    { stale: false, upTo: 4 },
  );
  // The same submit sent again after its answer was lost.
  assert.deepEqual(
    submitConflict({ known: 3, draft: row({ version: 4, cleared_at: "C" }), submission: { ...SUBMITTED, body: "laptop text" }, input }),
    { stale: false, upTo: 4 },
  );
  // A newer draft holding exactly this text overwrites nothing.
  assert.deepEqual(
    submitConflict({ known: 3, draft: row({ version: 4, body: "laptop text\n" }), submission: null, input }),
    { stale: false, upTo: 4 },
  );
});

test("before 0105 runs, the form behaves as it did without drafts", () => {
  const form = readFileSync(new URL("../components/assignments/submit-form.tsx", import.meta.url), "utf8");
  assert.match(form, /const enabled = autosave === "on";/);
  assert.match(form, /if \(!enabled \|\| stoppedRef\.current \|\| submittingRef\.current\) return;/);
  // No version is sent, so Submit compares and clears nothing (as before).
  assert.match(form, /draftVersion: enabled \? versionRef\.current : null,/);
  // And no unload prompt the old form didn't have.
  assert.match(form, /if \(autosave === "off"\) return;/);
  const detail = readFileSync(new URL("../components/assignments/assignment-detail.tsx", import.meta.url), "utf8");
  assert.match(detail, /autosave=\{draft\.state === "ready" \? "on" : draft\.state === "failed" \? "failed" : "off"\}/);
});

test("the form never says saved while an edit is waiting, and sends one as the page closes", () => {
  const form = readFileSync(new URL("../components/assignments/submit-form.tsx", import.meta.url), "utf8");
  // Dirty text reads "Saving draft…", not the last save's time.
  assert.match(form, /enabled && dirty && \(status\.kind === "idle" \|\| status\.kind === "restored" \|\| status\.kind === "saved"\)/);
  // beforeunload sends the unsaved text (a keepalive request) or asks first.
  assert.match(form, /if \(atRisk \|\| inFlightRef\.current\) ask = true;\s*else void saveRef\.current\(\);/);
  // Re-read on mount (Back/Forward) and on a stale answer before stopping.
  assert.match(form, /result\.reason === "stale" && \(await catchUp\(\)\)/);
  assert.match(form, /if \(r\.kind === "adopt"\) adopt\(r\.start, r\.handedIn\);/);
  // A stale submit asks, and only a yes sends force.
  assert.match(form, /if \(!force && window\.confirm\(STALE_CONFIRM\)\) \{\s*force = true;\s*continue;/);
});
