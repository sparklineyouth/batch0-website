import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  CATEGORY_HINTS,
  CATEGORY_LABELS,
  REPLY_BODY_MAX,
  STATUS_LABELS,
  STAFF_STATUS_LABELS,
  TICKET_BODY_MAX,
  TICKET_BODY_MIN,
  TICKET_CATEGORIES,
  TICKET_STATUSES,
  TICKET_SUBJECT_MAX,
  canRequesterReply,
  canStaffReply,
  formatReceivedAt,
  isOpenStatus,
  isTicketReference,
  isTicketToken,
  needsReplyFor,
  normalizeReference,
  statusAfterRequesterReply,
  statusAfterStaffReply,
  toCategory,
  toStatus,
  wantsReceiptRef,
  type TicketStatus,
} from "./support-access.ts";

// Run with `npm test`.
//
// Support tickets carry two promises that are stronger than the usual
// "don't show the wrong row" — one legal, one about trust:
//
//   1. A refund request filed through the form is a formal instrument under
//      app/(legal)/refund-policy. The policy now says the form is a valid
//      channel and that the recorded timestamp stops the 48-hour clock, so a
//      state machine that quietly drops a request, or refuses a follow-up on
//      one, has legal consequences and not just UX ones.
//   2. A resolved ticket must always be reopenable by the person who filed
//      it. "That didn't actually fix it" is the single most important message
//      a support system can accept.
//
// These pin both in code. The RLS policies in migration 0090 make the
// visibility half of the same promise at the row level, and the length caps
// below are asserted against that migration's own CHECK constraints so the
// three copies of the rule can't drift apart silently.

const open = { status: "open" as TicketStatus };
const waiting = { status: "waiting_on_requester" as TicketStatus };
const resolved = { status: "resolved" as TicketStatus };
const closed = { status: "closed" as TicketStatus };

// ---------------------------------------------------------------------------
// Who may speak
// ---------------------------------------------------------------------------

test("a requester can always reply except on a closed ticket", () => {
  assert.equal(canRequesterReply(open), true);
  assert.equal(canRequesterReply(waiting), true);
  assert.equal(
    canRequesterReply(resolved),
    true,
    "reopening a resolved ticket is the whole point of the resolved state",
  );
  assert.equal(canRequesterReply(closed), false);
});

test("the team can always reply, including on a closed ticket", () => {
  for (const t of [open, waiting, resolved, closed]) {
    assert.equal(canStaffReply(t), true, t.status);
  }
});

// ---------------------------------------------------------------------------
// The queue state machine
// ---------------------------------------------------------------------------

test("a requester's follow-up reopens a resolved ticket", () => {
  assert.equal(statusAfterRequesterReply(resolved), "open");
  assert.equal(statusAfterRequesterReply(waiting), "open");
  assert.equal(statusAfterRequesterReply(open), "open");
});

test("a closed ticket stays closed whoever posts on it", () => {
  assert.equal(statusAfterRequesterReply(closed), "closed");
  assert.equal(statusAfterStaffReply(closed), "closed");
});

test("the team answering parks the ticket on the requester", () => {
  assert.equal(statusAfterStaffReply(open), "waiting_on_requester");
  assert.equal(statusAfterStaffReply(waiting), "waiting_on_requester");
});

test("the team posting on a resolved ticket does not revive it", () => {
  // Adding "and here's the refund id" to a finished thread is the commonest
  // reason to post on one; it must not mark our own closed work as pending.
  assert.equal(statusAfterStaffReply(resolved), "resolved");
});

test("needs_reply tracks which side spoke last", () => {
  assert.equal(needsReplyFor(true), false, "the team's reply clears the queue flag");
  assert.equal(needsReplyFor(false), true, "a follow-up raises it again");
});

test("only open and waiting count as live", () => {
  assert.equal(isOpenStatus("open"), true);
  assert.equal(isOpenStatus("waiting_on_requester"), true);
  assert.equal(isOpenStatus("resolved"), false);
  assert.equal(isOpenStatus("closed"), false);
});

// ---------------------------------------------------------------------------
// Untrusted input
// ---------------------------------------------------------------------------

test("an unrecognised category falls back to other rather than throwing", () => {
  // A mistyped ?topic= in a link we put in a legal page must still open a
  // usable form, not an error page.
  assert.equal(toCategory("refund"), "refund");
  assert.equal(toCategory("REFUND"), "other", "matching is exact, not case-folded");
  assert.equal(toCategory("nonsense"), "other");
  assert.equal(toCategory(undefined), "other");
  assert.equal(toCategory(null), "other");
  assert.equal(toCategory(42), "other");
});

test("an unrecognised status filter is null, not a silent default", () => {
  // Distinct from toCategory on purpose: a bad status must not quietly show a
  // different slice of the queue than the admin asked for.
  assert.equal(toStatus("resolved"), "resolved");
  assert.equal(toStatus("queue"), null, "queue is a view, not a status");
  assert.equal(toStatus("nonsense"), null);
  assert.equal(toStatus(undefined), null);
});

test("only the money categories ask for a receipt", () => {
  assert.equal(wantsReceiptRef("refund"), true);
  assert.equal(wantsReceiptRef("billing"), true);
  assert.equal(wantsReceiptRef("account"), false);
  assert.equal(wantsReceiptRef("privacy"), false);
  assert.equal(wantsReceiptRef("other"), false);
});

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

test("a thread token is accepted only at exactly 43 base64url characters", () => {
  const good = "a".repeat(43);
  assert.equal(isTicketToken(good), true);
  assert.equal(isTicketToken("a".repeat(42)), false);
  assert.equal(isTicketToken("a".repeat(44)), false);
  assert.equal(isTicketToken(`${"a".repeat(42)}+`), false, "+ is not base64url");
  assert.equal(isTicketToken(`${"a".repeat(42)}/`), false, "/ is not base64url");
  assert.equal(isTicketToken("a".repeat(42) + "-"), true, "- and _ are");
  assert.equal(isTicketToken(null), false);
  assert.equal(isTicketToken(undefined), false);
  // Shape is checked before any database round trip, so a probe costs nothing
  // and learns nothing.
  assert.equal(isTicketToken("' or 1=1 --"), false);
});

test("a reference excludes the letters that get misread aloud", () => {
  assert.equal(isTicketReference("B0-4F2A-9C7K"), true);
  for (const bad of ["B0-4F2I-9C7K", "B0-4F2O-9C7K", "B0-4F2L-9C7K", "B0-4F2U-9C7K"]) {
    assert.equal(isTicketReference(bad), false, `${bad} contains an ambiguous symbol`);
  }
  assert.equal(isTicketReference("B0-4F20-9C7K"), false, "0 is excluded");
  assert.equal(isTicketReference("B0-4F21-9C7K"), false, "1 is excluded");
  assert.equal(isTicketReference("4F2A-9C7K"), false, "the prefix is required");
  assert.equal(isTicketReference("B0-4F2A9C7K"), false, "the hyphen is required");
});

test("a reference read off a receipt survives case and spacing", () => {
  const want = "B0-4F2A-9C7K";
  assert.equal(normalizeReference("b0-4f2a-9c7k"), want);
  assert.equal(normalizeReference("  B0 4F2A 9C7K  "), want);
  assert.equal(normalizeReference("4F2A9C7K"), want, "the prefix is optional on input");
  assert.equal(normalizeReference("B04F2A9C7K"), want);
  assert.equal(normalizeReference(""), "", "nothing usable returns nothing");
  assert.equal(normalizeReference("B0-4F2A"), "", "a partial reference is not guessed at");
  // Every excluded symbol, not just one: the negated character class in
  // normalizeReference is a separate copy of the alphabet from the validator's
  // positive one, and an L that survived the strip while failing the validator
  // is exactly the bug this covers.
  for (const bad of ["B0-4F2I-9C7K", "B0-4F2L-9C7K", "B0-4F2O-9C7K", "B0-4F2U-9C7K"]) {
    assert.equal(
      normalizeReference(bad),
      "",
      `${bad}: an ambiguous symbol is dropped, which makes the length wrong, which refuses it rather than silently resolving to a different real ticket`,
    );
  }
});

test("normalizeReference only ever emits references the validator accepts", () => {
  // The two functions hold independent copies of the alphabet. Anything the
  // normaliser returns non-empty must be a reference we can actually look up.
  const inputs = [
    "b0-4f2a-9c7k",
    "4F2A9C7K",
    "  B0 4F2A 9C7K  ",
    "B0-ZZZZ-2222",
    "b0/4f2a/9c7k",
    "B0-4F2L-9C7K",
    "B0-4F2I-9C7K",
    "garbage",
    "",
    "B0-4F2A-9C7K-EXTRA",
  ];
  for (const input of inputs) {
    const out = normalizeReference(input);
    if (out !== "") {
      assert.equal(
        isTicketReference(out),
        true,
        `normalizeReference(${JSON.stringify(input)}) returned ${out}, which the validator rejects`,
      );
    }
  }
});

test("every reference the generator can emit passes the validator", () => {
  // The generator and the SQL CHECK constraint share this alphabet; a symbol
  // in one but not the other is a row the database refuses to store.
  for (const c of "23456789ABCDEFGHJKMNPQRSTVWXYZ") {
    assert.equal(
      isTicketReference(`B0-${c}${c}${c}${c}-${c}${c}${c}${c}`),
      true,
      `alphabet symbol ${c} must be valid in a reference`,
    );
  }
});

// ---------------------------------------------------------------------------
// The arrival timestamp
//
// These exist because the first version of formatReceivedAt combined
// dateStyle/timeStyle with timeZoneName, which Intl rejects outright with
// `TypeError: Invalid option`. Nothing caught it: every Intl option is typed
// optional so tsc was clean, and all three call sites are force-dynamic so
// `next build` never rendered them — the function threw on every call while
// the suite stayed green. Only an executed assertion closes that gap.
// ---------------------------------------------------------------------------

test("formatReceivedAt returns a real timestamp instead of throwing", () => {
  const out = formatReceivedAt("2026-09-30T19:04:00.000Z");
  assert.equal(typeof out, "string");
  assert.ok(out.length > 0, "must not be empty");
  // 19:04 UTC on Sep 30 is 3:04 PM in New York, during EDT.
  assert.match(out, /September 30, 2026/);
  assert.match(out, /3:04/);
});

test("formatReceivedAt names the zone, which is the whole reason it exists", () => {
  // A timestamp that stops a legal clock cannot be printed without saying
  // which clock it is. This is also the assertion that fails if someone
  // "simplifies" the option bag back to dateStyle/timeStyle, because that
  // combination cannot carry a zone abbreviation at all.
  assert.match(formatReceivedAt("2026-09-30T19:04:00.000Z"), /EDT/);
  assert.match(formatReceivedAt("2026-01-15T19:04:00.000Z"), /EST/);
});

test("formatReceivedAt pins the zone rather than following the machine", () => {
  // Same instant, and the output must not depend on where the server is. A
  // viewer-local rendering would be ambiguous in exactly the dispute this
  // string exists to settle.
  const iso = "2026-07-04T02:30:00.000Z";
  assert.match(formatReceivedAt(iso), /July 3, 2026/);
  assert.match(formatReceivedAt(iso), /10:30 PM EDT/);
});

test("an unparseable timestamp yields an empty string, not an exception", () => {
  // The call sites render a page whose job is to show someone their support
  // request; a bad stored value must cost a line, not the page.
  for (const bad of ["", "not a date", "2026-13-45T99:99:99Z"]) {
    assert.equal(formatReceivedAt(bad), "", JSON.stringify(bad));
  }
});

// ---------------------------------------------------------------------------
// The vocabulary is complete
// ---------------------------------------------------------------------------

test("every category and status has copy for every surface", () => {
  // A missing label renders as `undefined` in a <Select> or an email subject,
  // which is the kind of bug that ships because nobody picked that option.
  for (const c of TICKET_CATEGORIES) {
    assert.equal(typeof CATEGORY_LABELS[c], "string", `${c} needs a label`);
    assert.ok(CATEGORY_LABELS[c].length > 0, `${c} label is empty`);
    assert.equal(typeof CATEGORY_HINTS[c], "string", `${c} needs a hint`);
    assert.ok(CATEGORY_HINTS[c].length > 0, `${c} hint is empty`);
  }
  for (const s of TICKET_STATUSES) {
    assert.ok(STATUS_LABELS[s]?.length > 0, `${s} needs a requester label`);
    assert.ok(STAFF_STATUS_LABELS[s]?.length > 0, `${s} needs a staff label`);
  }
});

test("the requester's status wording is second-person where it differs", () => {
  assert.equal(STATUS_LABELS.waiting_on_requester, "Waiting on you");
  assert.equal(STAFF_STATUS_LABELS.waiting_on_requester, "Waiting on requester");
});

// ---------------------------------------------------------------------------
// The caps match the database
// ---------------------------------------------------------------------------

test("the length caps are the ones migration 0090 enforces", () => {
  // The form uses these as maxLength and the action uses them as validation.
  // If they exceed the CHECK constraint, a user types a valid-looking message
  // and the insert fails with a Postgres error instead of a form message.
  const sql = readFileSync(
    new URL("../supabase/migrations/0090_support_tickets.sql", import.meta.url),
    "utf8",
  );
  assert.match(
    sql,
    new RegExp(`subject text not null check \\(char_length\\(subject\\) between 1 and ${TICKET_SUBJECT_MAX}\\)`),
  );
  assert.match(
    sql,
    new RegExp(`body text not null check \\(char_length\\(body\\) between ${TICKET_BODY_MIN} and ${TICKET_BODY_MAX}\\)`),
  );
  assert.match(
    sql,
    new RegExp(`body text not null check \\(char_length\\(body\\) between 1 and ${REPLY_BODY_MAX}\\)`),
    "the reply cap is the one on support_ticket_replies, which has no minimum",
  );
  assert.ok(
    TICKET_BODY_MIN < TICKET_BODY_MAX,
    "the minimum has to be reachable",
  );
});

test("migration 0090 enforces the token and reference shapes too", () => {
  const sql = readFileSync(
    new URL("../supabase/migrations/0090_support_tickets.sql", import.meta.url),
    "utf8",
  );
  assert.match(sql, /token text not null unique check \(token ~ '\^\[A-Za-z0-9_-\]\{43\}\$'\)/);
  assert.match(sql, /reference \~ '\^B0-\[2-9A-HJKMNP-TV-Z\]\{4\}-\[2-9A-HJKMNP-TV-Z\]\{4\}\$'/);
});

test("every category and status in the code is allowed by the migration", () => {
  // The CHECK constraints are the other half of these unions. A value the TS
  // accepts and the database refuses is an insert that fails at runtime only
  // for the option nobody tested.
  const sql = readFileSync(
    new URL("../supabase/migrations/0090_support_tickets.sql", import.meta.url),
    "utf8",
  );
  for (const c of TICKET_CATEGORIES) {
    assert.ok(sql.includes(`'${c}'`), `category ${c} is missing from the SQL check`);
  }
  for (const s of TICKET_STATUSES) {
    assert.ok(sql.includes(`'${s}'`), `status ${s} is missing from the SQL check`);
  }
});

// ---------------------------------------------------------------------------
// The tables are locked down
// ---------------------------------------------------------------------------

test("migration 0090 revokes the default grants and adds no requester write policy", () => {
  const sql = readFileSync(
    new URL("../supabase/migrations/0090_support_tickets.sql", import.meta.url),
    "utf8",
  );
  // Supabase grants anon/authenticated `all` on tables a later migration
  // creates, via ALTER DEFAULT PRIVILEGES. Without these revokes the tables
  // are a landmine for whoever adds a permissive policy next.
  assert.match(sql, /revoke all on public\.support_tickets from anon, authenticated;/);
  assert.match(
    sql,
    /revoke all on public\.support_ticket_replies from anon, authenticated;/,
  );
  assert.match(sql, /alter table public\.support_tickets enable row level security;/);
  assert.match(
    sql,
    /alter table public\.support_ticket_replies enable row level security;/,
  );
  // Writes are server-only so the server owns requester_email, is_staff,
  // is_internal, token and reference. An insert policy would let the browser
  // choose them.
  assert.ok(
    !/for insert/i.test(sql),
    "there must be no INSERT policy — every write goes through the service role",
  );
  // Without this the tables are invisible to PostgREST and a correct deploy
  // presents as PGRST205.
  assert.match(sql, /notify pgrst, 'reload schema';/);
});

test("internal notes are hidden from a requester at the row level too", () => {
  const sql = readFileSync(
    new URL("../supabase/migrations/0090_support_tickets.sql", import.meta.url),
    "utf8",
  );
  // lib/support.ts defaults includeInternal to false, but the reply-read
  // policy has to carry the same rule: a requester who can see the ticket
  // still must not see the team's notes about them.
  const policy = /create policy "support_ticket_replies read"[\s\S]*?\);/.exec(sql);
  assert.ok(policy, "the reply read policy must exist");
  assert.match(policy[0], /not is_internal/);
  assert.match(policy[0], /has_permission\(auth\.uid\(\), 'support\.view'\)/);
});
