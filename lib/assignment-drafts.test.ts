import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  checkDraft,
  draftRetryDelay,
  draftStatusLine,
  interpretDraftSave,
  isFinalDraftFailure,
  sameWork,
  startingWork,
  type DraftFailure,
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
  // only reader of the drafts table is the student's own page.
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
  const actions = readFileSync(new URL("../app/dashboard/assignments/actions.ts", import.meta.url), "utf8");
  const saver = actions.slice(actions.indexOf("export async function saveAssignmentDraft"));
  // Autosave never writes a submission, bells anyone, or redirects.
  assert.doesNotMatch(saver, /course_assignment_submissions|notify|revalidatePath|redirect\(/);
  assert.match(saver, /rpc\("save_course_assignment_draft"/);
  // Submitting clears only the draft versions this tab knew about.
  assert.match(actions, /\.lte\("version", knownDraft\)/);
});

test("before 0105 runs, the form behaves as it did without drafts", () => {
  const form = readFileSync(new URL("../components/assignments/submit-form.tsx", import.meta.url), "utf8");
  assert.match(form, /const enabled = autosave === "on";/);
  assert.match(form, /if \(!enabled \|\| stoppedRef\.current \|\| submittingRef\.current\) return;/);
  const detail = readFileSync(new URL("../components/assignments/assignment-detail.tsx", import.meta.url), "utf8");
  assert.match(detail, /autosave=\{draft\.state === "ready" \? "on" : draft\.state === "failed" \? "failed" : "off"\}/);
});
