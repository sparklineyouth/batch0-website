import test from "node:test";
import assert from "node:assert/strict";
import { capabilitiesFrom } from "./permissions.ts";
import {
  FOLLOWUP_MAX_DAYS_AHEAD,
  FOLLOWUP_NOTE_MAX,
  canReadFollowUps,
  canWriteFollowUps,
  daysBetween,
  defaultNextCheck,
  followUpDueLabel,
  followUpDueState,
  followUpOwnerRoleSlugs,
  formatCheckDate,
  isFollowUpDue,
  isOneOpenConflict,
  parseClosingNote,
  parseFollowUpInput,
} from "./student-followups.ts";

const TODAY = "2026-10-17";
const OWNER = "00000000-0000-4000-8000-0000000000aa";

test("reading needs people.view; changing needs people.manage as well", () => {
  const caps = (...p: string[]) => capabilitiesFrom("custom", p);
  assert.equal(canReadFollowUps(caps("people.view")), true);
  assert.equal(canWriteFollowUps(caps("people.view")), false);
  assert.equal(canWriteFollowUps(caps("people.view", "people.manage")), true);
  // people.manage alone can't open the page the drawer lives on.
  assert.equal(canWriteFollowUps(caps("people.manage")), false);
  assert.equal(canReadFollowUps(caps("support.view")), false);
  assert.equal(canWriteFollowUps(caps("*")), true);
  assert.equal(canReadFollowUps(null), false);
});

test("owners are people who could update and close it themselves", () => {
  assert.deepEqual(
    followUpOwnerRoleSlugs([
      { slug: "admin", permissions: ["*"] },
      { slug: "ops", permissions: ["people.view", "people.manage"] },
      { slug: "intern", permissions: ["people.view"] },
      { slug: "mentor", permissions: ["mentor.panel"] },
      { slug: "odd", permissions: ["people.manage"] },
    ]),
    ["admin", "ops"],
  );
});

test("the drawer's input: owner, a date today or later, and a note", () => {
  const ok = parseFollowUpInput({ ownerId: OWNER.toUpperCase(), nextCheckOn: "2026-10-24", note: "  Missed weeks 3 and 4. Emailed Tuesday.  " }, TODAY);
  assert.deepEqual(ok, { ok: true, value: { ownerId: OWNER, nextCheckOn: "2026-10-24", note: "Missed weeks 3 and 4. Emailed Tuesday." } });
  // Today is fine: "I'll look again later today".
  assert.equal(parseFollowUpInput({ ownerId: OWNER, nextCheckOn: TODAY, note: "x" }, TODAY).ok, true);

  const err = (raw: Record<string, unknown>) => {
    const r = parseFollowUpInput({ ownerId: OWNER, nextCheckOn: "2026-10-24", note: "Fine", ...raw }, TODAY);
    return r.ok ? null : r.error;
  };
  assert.match(err({ ownerId: "" })!, /who owns/);
  assert.match(err({ ownerId: "not-a-uuid" })!, /who owns/);
  assert.match(err({ nextCheckOn: "2026-02-30" })!, /date/);
  assert.match(err({ nextCheckOn: "2026-10-16" })!, /past/);
  assert.equal(err({ nextCheckOn: "2027-02-14" }), null, `${FOLLOWUP_MAX_DAYS_AHEAD} days out is the limit`);
  assert.match(err({ nextCheckOn: "2027-02-15" })!, /within/);
  assert.match(err({ note: "   " })!, /note/);
  assert.match(err({ note: 42 })!, /note/);
  assert.equal(err({ note: "é".repeat(FOLLOWUP_NOTE_MAX) }), null, "counted in characters, like char_length()");
  assert.match(err({ note: "a".repeat(FOLLOWUP_NOTE_MAX + 1) })!, /under/);
});

test("the closing note is optional", () => {
  assert.deepEqual(parseClosingNote(undefined), { ok: true, value: null });
  assert.deepEqual(parseClosingNote("   "), { ok: true, value: null });
  assert.deepEqual(parseClosingNote(" Handed in week 5. "), { ok: true, value: "Handed in week 5." });
  assert.equal(parseClosingNote("a".repeat(FOLLOWUP_NOTE_MAX + 1)).ok, false);
});

test("due: today or earlier, open only", () => {
  const open = (d: string) => ({ status: "open" as const, nextCheckOn: d });
  assert.equal(followUpDueState(open("2026-10-16"), TODAY), "overdue");
  assert.equal(followUpDueState(open(TODAY), TODAY), "due");
  assert.equal(followUpDueState(open("2026-10-18"), TODAY), "upcoming");
  assert.equal(followUpDueState({ status: "closed", next_check_on: "2026-10-01" }, TODAY), "closed");
  assert.equal(isFollowUpDue({ status: "open", next_check_on: TODAY }, TODAY), true);
  assert.equal(isFollowUpDue({ status: "closed", next_check_on: TODAY }, TODAY), false);
  assert.equal(isFollowUpDue(open("2026-10-18"), TODAY), false);
});

test("labels and dates read the same on the server and in any browser", () => {
  assert.equal(daysBetween("2026-10-17", "2026-11-02"), 16, "across the end of daylight saving time");
  assert.equal(followUpDueLabel(TODAY, TODAY), "Due today");
  assert.equal(followUpDueLabel("2026-10-16", TODAY), "Due yesterday");
  assert.equal(followUpDueLabel("2026-10-12", TODAY), "Due 5 days ago");
  assert.equal(followUpDueLabel("2026-10-18", TODAY), "Tomorrow");
  assert.equal(followUpDueLabel("2026-10-21", TODAY), "In 4 days");
  assert.equal(formatCheckDate("2026-10-20"), "Tue, Oct 20");
  assert.equal(formatCheckDate("nope"), "");
});

test("the date picker starts a week out, or on the open follow-up's date while it's ahead", () => {
  assert.equal(defaultNextCheck(null, TODAY), "2026-10-24");
  assert.equal(defaultNextCheck({ nextCheckOn: "2026-10-30" }, TODAY), "2026-10-30");
  // Due today or overdue: you're checking now, so the next one is a week out.
  assert.equal(defaultNextCheck({ nextCheckOn: TODAY }, TODAY), "2026-10-24");
  assert.equal(defaultNextCheck({ nextCheckOn: "2026-10-01" }, TODAY), "2026-10-24");
});

test("a second open follow-up is the unique index's 23505", () => {
  assert.equal(isOneOpenConflict({ code: "23505" }), true);
  assert.equal(isOneOpenConflict({ code: "23514" }), false);
  assert.equal(isOneOpenConflict(null), false);
});
