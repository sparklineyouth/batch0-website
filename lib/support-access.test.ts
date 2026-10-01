import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isSecretUrlPath } from "./payment-privacy.ts";
import {
  AUTO_RESOLVE_AFTER_DAYS,
  AUTO_RESOLVE_NOTE,
  CATEGORY_DEFAULT_PRIORITY,
  CATEGORY_GROUPS,
  CATEGORY_HINTS,
  CATEGORY_LABELS,
  CHANNEL_LABELS,
  OUTCOME_LABELS,
  PRIORITY_LABELS,
  PRIORITY_RANK,
  REPLY_BODY_MAX,
  REPLY_VIAS,
  SLA_TARGET_HOURS,
  STAFF_LOG_CHANNELS,
  STATUS_LABELS,
  STAFF_STATUS_LABELS,
  TICKET_BODY_MAX,
  TICKET_BODY_MIN,
  TICKET_CATEGORIES,
  TICKET_CHANNELS,
  TICKET_OUTCOMES,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  TICKET_SUBJECT_MAX,
  canRequesterMarkSolved,
  canRequesterReply,
  canStaffManageTicket,
  canStaffReply,
  canStaffSeeTicket,
  checkStaffReceivedAt,
  codePointLength,
  defaultPriorityFor,
  deriveSubject,
  easternLocalToIso,
  escapeLikePattern,
  formatElapsed,
  formatReceivedAt,
  ilikeAnyFilter,
  isOpenStatus,
  isSecretPath,
  isSensitiveCategory,
  isTicketReference,
  isTicketToken,
  isUuid,
  needsReplyForStatus,
  normalizeReference,
  parseCategory,
  readStoredContext,
  refundWindow,
  sanitizeContext,
  sanitizeContextPage,
  slaDueAt,
  slaState,
  statusAfterRequesterReply,
  statusAfterStaffReply,
  statusChangeFields,
  supportScopeFor,
  supportSearchPlan,
  toCategory,
  toEasternLocalInput,
  toOutcome,
  toPriority,
  toStaffLogChannel,
  toStatus,
  toSurface,
  wantsReceiptRef,
  type TicketStatus,
} from "./support-access.ts";

// Run with `npm test`.
//
// Support tickets carry two promises that are stronger than the usual
// "don't show the wrong row" — one legal, one about trust:
//
//   1. A refund request filed through the form (or logged by the team from an
//      email) is a formal instrument under app/(legal)/refund-policy. The
//      recorded arrival time stops the 48-hour clock, so a state machine that
//      quietly drops a request, refuses a follow-up on one, or mis-measures
//      the window has legal consequences and not just UX ones.
//   2. A confidential concern is readable only by the few people trusted with
//      it, and a resolved ticket is always reopenable by the person who filed
//      it.
//
// These pin both in code. The RLS policies in migration 0090 make the
// visibility half of the same promise at the row level (exercised in
// lib/support-migration-db.test.ts), and the vocabularies and length caps
// below are read back out of that migration so the copies can't drift.

const open = { status: "open" as TicketStatus };
const waiting = { status: "waiting_on_requester" as TicketStatus };
const resolved = { status: "resolved" as TicketStatus };
const closed = { status: "closed" as TicketStatus };

const SQL = readFileSync(
  new URL("../supabase/migrations/0090_support_tickets.sql", import.meta.url),
  "utf8",
);

/** The quoted values of an `X in ('a', 'b')` list in the named constraint. */
function sqlList(pattern: RegExp): string[] {
  const m = pattern.exec(SQL);
  assert.ok(m, `pattern ${pattern} not found in 0090`);
  return [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1]).sort();
}

const sorted = (xs: readonly string[]) => [...xs].sort();

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

test("a requester can mark only a live ticket solved", () => {
  assert.equal(canRequesterMarkSolved(open), true);
  assert.equal(canRequesterMarkSolved(waiting), true);
  assert.equal(canRequesterMarkSolved(resolved), false);
  assert.equal(canRequesterMarkSolved(closed), false);
});

test("the team can always reply, including on a closed ticket", () => {
  for (const t of [open, waiting, resolved, closed]) {
    assert.equal(canStaffReply(t), true, t.status);
  }
});

// ---------------------------------------------------------------------------
// The status machine
// ---------------------------------------------------------------------------

test("a requester's follow-up reopens anything but a closed ticket", () => {
  assert.equal(statusAfterRequesterReply(resolved), "open");
  assert.equal(statusAfterRequesterReply(waiting), "open");
  assert.equal(statusAfterRequesterReply(open), "open");
  assert.equal(statusAfterRequesterReply(closed), "closed");
});

test("the team answering parks the ticket on the requester by default", () => {
  assert.equal(statusAfterStaffReply(open), "waiting_on_requester");
  assert.equal(statusAfterStaffReply(waiting), "waiting_on_requester");
});

test("the team posting on a resolved ticket does not revive it", () => {
  // Adding "and here's the refund id" to a finished thread is the commonest
  // reason to post on one; it must not mark our own finished work as pending.
  assert.equal(statusAfterStaffReply(resolved), "resolved");
});

test("send & resolve, and keep-open, are honoured — but never on a closed ticket", () => {
  assert.equal(statusAfterStaffReply(open, "resolved"), "resolved");
  assert.equal(statusAfterStaffReply(waiting, "resolved"), "resolved");
  assert.equal(statusAfterStaffReply(open, "open"), "open", "we still owe something");
  assert.equal(statusAfterStaffReply(resolved, "open"), "open");
  assert.equal(statusAfterStaffReply(closed, "resolved"), "closed");
  assert.equal(statusAfterStaffReply(closed, "open"), "closed", "reopening is the status control's job");
  assert.equal(
    statusAfterStaffReply(open, "closed"),
    "waiting_on_requester",
    "a reply is never the way a ticket gets closed",
  );
});

test("needs_reply is exactly 'open'", () => {
  assert.deepEqual(
    TICKET_STATUSES.filter(needsReplyForStatus),
    ["open"],
  );
});

test("only open and waiting count as live", () => {
  assert.equal(isOpenStatus("open"), true);
  assert.equal(isOpenStatus("waiting_on_requester"), true);
  assert.equal(isOpenStatus("resolved"), false);
  assert.equal(isOpenStatus("closed"), false);
});

test("a status change writes its bookkeeping together", () => {
  const now = "2026-10-01T12:00:00.000Z";
  assert.deepEqual(statusChangeFields("open", "resolved", now, "answered"), {
    status: "resolved",
    needs_reply: false,
    status_changed_at: now,
    resolved_at: now,
    outcome: "answered",
  });
  assert.deepEqual(
    statusChangeFields("resolved", "open", now),
    { status: "open", needs_reply: true, status_changed_at: now, resolved_at: null, outcome: null },
    "reopening clears the resolution it is undoing",
  );
  assert.deepEqual(
    statusChangeFields("resolved", "closed", now),
    { status: "closed", needs_reply: false, status_changed_at: now },
    "closing a resolved ticket keeps when it was resolved and how it ended",
  );
  assert.deepEqual(statusChangeFields("open", "waiting_on_requester", now), {
    status: "waiting_on_requester",
    needs_reply: false,
    status_changed_at: now,
    resolved_at: null,
    outcome: null,
  });
  assert.equal(
    statusChangeFields("open", "closed", now, "duplicate").outcome,
    "duplicate",
  );
  for (const from of TICKET_STATUSES) {
    for (const to of TICKET_STATUSES) {
      if (from === to) continue;
      assert.equal(
        statusChangeFields(from, to, now).needs_reply,
        to === "open",
        `${from} → ${to} must keep needs_reply ⇔ open`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// Untrusted input
// ---------------------------------------------------------------------------

test("an unrecognised topic falls back to other; a form post must say what it is", () => {
  // A mistyped ?topic= in a link we put in a legal page must still open a
  // usable form…
  assert.equal(toCategory("refund"), "refund");
  assert.equal(toCategory("REFUND"), "other", "matching is exact, not case-folded");
  assert.equal(toCategory("nonsense"), "other");
  assert.equal(toCategory(undefined), "other");
  assert.equal(toCategory(42), "other");
  // …but the submitted form must not silently file a refund as "Something else".
  assert.equal(parseCategory("technical"), "technical");
  assert.equal(parseCategory("nonsense"), null);
  assert.equal(parseCategory(""), null);
  assert.equal(parseCategory(undefined), null);
});

test("unrecognised filters are null, not a silent default", () => {
  assert.equal(toStatus("resolved"), "resolved");
  assert.equal(toStatus("needs_reply"), null, "a view is not a status");
  assert.equal(toStatus(undefined), null);
  assert.equal(toPriority("urgent"), "urgent");
  assert.equal(toPriority("critical"), null);
  assert.equal(toOutcome("partially_refunded"), "partially_refunded");
  assert.equal(toOutcome("won"), null);
  assert.equal(toStaffLogChannel("phone"), "phone");
  assert.equal(toStaffLogChannel("web"), null, "staff log what arrived by email, phone or other");
  assert.equal(toSurface("app"), "app");
  assert.equal(toSurface("anything"), "web");
});

test("only the money categories ask for a receipt", () => {
  assert.deepEqual(TICKET_CATEGORIES.filter(wantsReceiptRef), ["refund", "billing"]);
});

test("uuids are checked by shape", () => {
  assert.equal(isUuid("11111111-1111-4111-8111-111111111111"), true);
  assert.equal(isUuid("11111111-1111-4111-8111-11111111111"), false);
  assert.equal(isUuid("'; drop table x; --"), false);
  assert.equal(isUuid(null), false);
});

test("lengths are measured the way Postgres measures them", () => {
  // Ten emoji are 20 UTF-16 units and 10 characters to char_length. A
  // .length check would pass a body the database then refuses.
  const tenEmoji = "😀".repeat(10);
  assert.equal(tenEmoji.length, 20);
  assert.equal(codePointLength(tenEmoji), 10);
  assert.ok(codePointLength(tenEmoji) < TICKET_BODY_MIN);
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
  for (const bad of ["B0-4F2I-9C7K", "B0-4F2L-9C7K", "B0-4F2O-9C7K", "B0-4F2U-9C7K"]) {
    assert.equal(
      normalizeReference(bad),
      "",
      `${bad}: an ambiguous symbol is dropped, which makes the length wrong, which refuses it rather than silently resolving to a different real ticket`,
    );
  }
});

test("normalizeReference only ever emits references the validator accepts", () => {
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
// optional so tsc was clean, and every call site is force-dynamic so
// `next build` never rendered them — the function threw on every call while
// the suite stayed green. Only an executed assertion closes that gap.
// ---------------------------------------------------------------------------

test("formatReceivedAt returns a real timestamp instead of throwing", () => {
  const out = formatReceivedAt("2026-09-30T19:04:00.000Z");
  assert.ok(out.length > 0, "must not be empty");
  // 19:04 UTC on Sep 30 is 3:04 PM in New York, during EDT.
  assert.match(out, /September 30, 2026/);
  assert.match(out, /3:04/);
});

test("formatReceivedAt names the zone, which is the whole reason it exists", () => {
  assert.match(formatReceivedAt("2026-09-30T19:04:00.000Z"), /EDT/);
  assert.match(formatReceivedAt("2026-01-15T19:04:00.000Z"), /EST/);
});

test("formatReceivedAt pins the zone rather than following the machine", () => {
  const iso = "2026-07-04T02:30:00.000Z";
  assert.match(formatReceivedAt(iso), /July 3, 2026/);
  assert.match(formatReceivedAt(iso), /10:30 PM EDT/);
});

test("an unparseable timestamp yields an empty string, not an exception", () => {
  for (const bad of ["", "not a date", "2026-13-45T99:99:99Z"]) {
    assert.equal(formatReceivedAt(bad), "", JSON.stringify(bad));
  }
});

test("a staff-entered arrival time is read as New York time, across DST", () => {
  // EDT (UTC-4) in October, EST (UTC-5) in January.
  assert.equal(easternLocalToIso("2026-10-01T09:30"), "2026-10-01T13:30:00.000Z");
  assert.equal(easternLocalToIso("2026-01-15T09:30"), "2026-01-15T14:30:00.000Z");
  // Either side of the November change, the wall time lands on its own offset.
  assert.equal(easternLocalToIso("2026-11-01T00:30"), "2026-11-01T04:30:00.000Z");
  assert.equal(easternLocalToIso("2026-11-01T03:00"), "2026-11-01T08:00:00.000Z");
  // And it round-trips back into the form.
  for (const local of ["2026-10-01T09:30", "2026-01-15T23:59", "2026-03-08T12:00"]) {
    assert.equal(toEasternLocalInput(easternLocalToIso(local)!), local);
  }
  // Nonsense is refused rather than rolled over into another day.
  for (const bad of ["", "2026-02-31T09:00", "2026-10-01 09:30x", "yesterday", "2026-10-01T25:00"]) {
    assert.equal(easternLocalToIso(bad), null, bad);
  }
});

test("a logged request can't be dated in the future or past the 90-day horizon", () => {
  const now = Date.parse("2026-10-01T12:00:00Z");
  assert.equal(checkStaffReceivedAt("2026-10-01T11:00:00Z", now), null);
  assert.equal(checkStaffReceivedAt("2026-10-01T12:00:30Z", now), null, "a fast clock gets a minute");
  assert.match(checkStaffReceivedAt("2026-10-01T13:00:00Z", now)!, /future/);
  assert.equal(checkStaffReceivedAt("2026-07-04T12:00:00Z", now), null, "89 days");
  assert.match(checkStaffReceivedAt("2026-06-01T12:00:00Z", now)!, /90 days/);
  assert.match(checkStaffReceivedAt(null, now)!, /date and time/);
});

// ---------------------------------------------------------------------------
// Staff scope — the TS half of the sensitive rule
// ---------------------------------------------------------------------------

test("the staff scope mirrors the policies: view or manage reads, sensitive is extra", () => {
  const scope = (perms: string[], superAdmin = false) =>
    supportScopeFor("u", { permissions: perms, superAdmin });
  const normal = { sensitive: false };
  const concern = { sensitive: true };

  const viewer = scope(["support.view"]);
  assert.deepEqual(
    [canStaffSeeTicket(viewer, normal), canStaffSeeTicket(viewer, concern), viewer.canManage],
    [true, false, false],
  );
  const manager = scope(["support.manage"]);
  assert.equal(manager.canView, true, "manage implies reading what you answer");
  assert.equal(canStaffManageTicket(manager, normal), true);
  assert.equal(canStaffManageTicket(manager, concern), false);

  const senior = scope(["support.view", "support.manage", "support.sensitive"]);
  assert.equal(canStaffManageTicket(senior, concern), true);

  const sensitiveAlone = scope(["support.sensitive"]);
  assert.deepEqual(
    sensitiveAlone,
    { userId: "u", canView: false, canManage: false, canSeeSensitive: false },
    "support.sensitive opens nothing on its own",
  );
  const star = scope([], true);
  assert.equal(canStaffManageTicket(star, concern), true);
  assert.deepEqual(supportScopeFor("u", null), {
    userId: "u",
    canView: false,
    canManage: false,
    canSeeSensitive: false,
  });
});

test("only concerns are confidential by default, and they start urgent", () => {
  assert.deepEqual(TICKET_CATEGORIES.filter(isSensitiveCategory), ["concern"]);
  assert.equal(defaultPriorityFor("concern"), "urgent");
  assert.equal(defaultPriorityFor("refund"), "high");
  assert.equal(defaultPriorityFor("feedback"), "low");
  for (const c of TICKET_CATEGORIES) {
    if (!["concern", "refund", "feedback"].includes(c)) {
      assert.equal(CATEGORY_DEFAULT_PRIORITY[c], "normal", c);
    }
  }
});

// ---------------------------------------------------------------------------
// Reply targets
// ---------------------------------------------------------------------------

test("reply targets run from the requester's last message, by priority", () => {
  assert.deepEqual(SLA_TARGET_HOURS, { urgent: 4, high: 24, normal: 48, low: 72 });
  const from = "2026-10-01T12:00:00.000Z";
  const at = (hours: number) => Date.parse(from) + hours * 3_600_000;
  const t = (priority: "urgent" | "high" | "normal" | "low", needsReply = true) => ({
    priority,
    needsReply,
    requesterActivityAt: from,
  });

  assert.equal(slaDueAt(t("urgent")), "2026-10-01T16:00:00.000Z");
  assert.equal(slaState(t("urgent"), at(1)), "ok");
  assert.equal(slaState(t("urgent"), at(3)), "due_soon", "75% of the target gone");
  assert.equal(slaState(t("urgent"), at(4)), "due_soon", "due now is not yet overdue");
  assert.equal(slaState(t("urgent"), at(4) + 1), "overdue");
  assert.equal(slaState(t("normal"), at(35)), "ok");
  assert.equal(slaState(t("normal"), at(36)), "due_soon");
  assert.equal(slaState(t("low"), at(73)), "overdue");
  assert.equal(slaState(t("high"), new Date(at(25))), "overdue", "takes a Date too");

  // Nobody owes a reply on a ticket that doesn't need one.
  assert.equal(slaDueAt(t("urgent", false)), null);
  assert.equal(slaState(t("urgent", false), at(1000)), "ok");
});

// ---------------------------------------------------------------------------
// The refund window
// ---------------------------------------------------------------------------

test("the refund window is 48 consecutive hours, inclusive", () => {
  const paid = "2026-09-29T15:00:00.000Z";
  const after = (ms: number) => new Date(Date.parse(paid) + ms).toISOString();
  const H = 3_600_000;

  const exactly = refundWindow(after(48 * H), paid);
  assert.equal(exactly.state, "inside", "exactly 48:00 is still inside");
  assert.equal(exactly.elapsedMs, 48 * H);
  assert.equal(exactly.label, "Received 48h 0m after payment — inside the 48-hour window.");

  const oneMinuteLate = refundWindow(after(48 * H + 60_000), paid);
  assert.equal(oneMinuteLate.state, "outside");
  assert.equal(oneMinuteLate.label, "Received 48h 1m after payment — outside the 48-hour window.");

  assert.equal(refundWindow(after(48 * H + 1), paid).state, "outside", "one millisecond over is over");
  assert.equal(refundWindow(after(3 * H + 12 * 60_000), paid).label,
    "Received 3h 12m after payment — inside the 48-hour window.");
  assert.equal(refundWindow(after(0), paid).state, "inside", "at the moment of payment");
  assert.match(refundWindow(after(5 * 24 * H), paid).label, /5d 0h after payment — outside/);
});

test("a refund window that can't be measured says so instead of guessing", () => {
  const paid = "2026-09-29T15:00:00.000Z";
  const before = refundWindow("2026-09-29T14:00:00.000Z", paid);
  assert.equal(before.state, "before_payment");
  assert.equal(before.label, "Received 1h 0m before this payment was made.");
  assert.equal(refundWindow("2026-09-30T15:00:00.000Z", null).state, "unknown");
  assert.equal(refundWindow("2026-09-30T15:00:00.000Z", "garbage").state, "unknown");
  assert.equal(refundWindow(null, paid).state, "unknown");
  assert.equal(refundWindow(null, paid).elapsedMs, null);
});

test("elapsed time is compact and readable", () => {
  assert.equal(formatElapsed(45 * 60_000), "45m");
  assert.equal(formatElapsed(71 * 3_600_000 + 59 * 60_000), "71h 59m");
  assert.equal(formatElapsed(72 * 3_600_000), "3d 0h");
  assert.equal(formatElapsed(-90 * 60_000), "1h 30m");
});

// ---------------------------------------------------------------------------
// Filing context
// ---------------------------------------------------------------------------

test("the secret-URL rule is the same one analytics uses", () => {
  // lib/payment-privacy.ts owns the rule; this file mirrors it because it must
  // stay import-free. A secret path added there and not here fails this test.
  const paths = [
    "/support/t/abc",
    "/support/t/",
    "/support/thanks",
    "/support",
    "/demo-day/ticket/xyz",
    "/demo-day/tickets",
    "/demo-day",
    "/pay",
    "/dashboard/support/B0-AAAA-2222",
    "/",
    "",
    null,
  ];
  for (const p of paths) {
    assert.equal(isSecretPath(p), isSecretUrlPath(p), JSON.stringify(p));
  }
});

test("a context page is a same-site pathname with no query, hash or secret", () => {
  assert.equal(sanitizeContextPage("/dashboard/billing"), "/dashboard/billing");
  assert.equal(
    sanitizeContextPage("/dashboard/billing?session_id=cs_live_abc#top"),
    "/dashboard/billing",
    "query strings are where secrets travel",
  );
  assert.equal(sanitizeContextPage("  /dashboard  "), "/dashboard");
  for (const bad of [
    "https://evil.example/dashboard",
    "//evil.example/dashboard",
    "/\\evil.example",
    "/dash\\board",
    "dashboard",
    "/support/t/" + "a".repeat(43),
    "/demo-day/ticket/abc",
    "/has space",
    "/" + "a".repeat(300),
    "",
    42,
    null,
  ]) {
    assert.equal(sanitizeContextPage(bad), null, JSON.stringify(bad));
  }
  assert.equal(sanitizeContextPage("/" + "a".repeat(299))?.length, 300, "300 is allowed");
});

test("the context whitelist keeps only well-formed keys", () => {
  const ctx = sanitizeContext({
    page: "/dashboard/course/abc?x=1",
    source: "Error_Screen",
    digest: "1234567890",
    userAgent: "Mozilla/5.0\n(Macintosh)\t Safari",
    surface: "app",
    // Not on the whitelist, and not settable from a form even though they
    // are stored keys: ownership is verified server-side first.
    chargeId: "11111111-1111-4111-8111-111111111111",
    token: "secret",
  } as any);
  assert.deepEqual(ctx, {
    page: "/dashboard/course/abc",
    source: "error_screen",
    digest: "1234567890",
    userAgent: "Mozilla/5.0 (Macintosh) Safari",
    surface: "app",
  });
  assert.deepEqual(
    sanitizeContext({
      page: "/support/t/" + "a".repeat(43),
      source: "has spaces",
      digest: "<script>",
      userAgent: "",
      surface: "desktop",
    }),
    {},
  );
  assert.equal(
    sanitizeContext({ source: "a".repeat(41) }).source,
    undefined,
    "source is at most 40 characters",
  );
  assert.equal(sanitizeContext({ digest: "a".repeat(65) }).digest, undefined);
  assert.equal(
    sanitizeContext({ userAgent: "x".repeat(500) }).userAgent?.length,
    300,
    "a long user agent is trimmed, not refused",
  );
  // Worst case still fits the 4 KB CHECK with room to spare.
  const worst = sanitizeContext({
    page: "/" + "a".repeat(299),
    source: "a".repeat(40),
    digest: "a".repeat(64),
    userAgent: "😀".repeat(400),
    surface: "app",
  });
  assert.ok(Buffer.byteLength(JSON.stringify(worst)) < 2048);
});

test("a stored context is re-checked on the way out", () => {
  assert.deepEqual(readStoredContext(null), {});
  assert.deepEqual(readStoredContext([1, 2]), {});
  assert.deepEqual(
    readStoredContext({
      page: "/dashboard",
      chargeId: "11111111-1111-4111-8111-111111111111",
      demoDayTicketId: "not-a-uuid",
      extra: "dropped",
    }),
    { page: "/dashboard", chargeId: "11111111-1111-4111-8111-111111111111" },
  );
});

// ---------------------------------------------------------------------------
// Subject
// ---------------------------------------------------------------------------

test("a typed subject wins, collapsed and held to the column's cap", () => {
  assert.equal(
    deriveSubject({ subject: "  Refund   for\ntuition ", body: "x".repeat(30), category: "refund" }),
    "Refund for tuition",
  );
  const long = deriveSubject({ subject: "word ".repeat(60), body: "", category: "other" });
  assert.ok(codePointLength(long) <= TICKET_SUBJECT_MAX);
  assert.ok(long.endsWith("…"));
});

test("a blank subject comes from the first line of the body, then the category", () => {
  assert.equal(
    deriveSubject({ subject: "", body: "\n\n  The video in week 2 won't play  \nIt spins.", category: "technical" }),
    "The video in week 2 won't play",
  );
  const derived = deriveSubject({
    subject: null,
    body: "I was charged twice for tuition on September 29 and I would like the duplicate charge refunded to my card please",
    category: "billing",
  });
  assert.ok(codePointLength(derived) <= 80, derived);
  assert.ok(derived.endsWith("…"));
  assert.ok(!derived.includes("  "));
  assert.equal(
    derived,
    "I was charged twice for tuition on September 29 and I would like the duplicate…",
    "cut at a word boundary, never mid-word",
  );
  assert.equal(deriveSubject({ subject: "   ", body: "   \n  ", category: "concern" }), "Report a concern");
  // A first line with no spaces is cut, not lost.
  const noSpaces = deriveSubject({ subject: "", body: "x".repeat(200), category: "other" });
  assert.equal(codePointLength(noSpaces), 80);
  // Emoji are counted the way Postgres counts them, and never split in half.
  const emoji = deriveSubject({ subject: "", body: "😀".repeat(100), category: "other" });
  assert.equal(codePointLength(emoji), 80);
  assert.ok(!emoji.includes("�"));
});

// ---------------------------------------------------------------------------
// Staff search
// ---------------------------------------------------------------------------

test("a reference-shaped search is an exact lookup; anything else is a contains", () => {
  assert.deepEqual(supportSearchPlan("b0-4f2a-9c7k"), { kind: "reference", reference: "B0-4F2A-9C7K" });
  assert.deepEqual(supportSearchPlan(" B0 4F2A 9C7K "), { kind: "reference", reference: "B0-4F2A-9C7K" });
  assert.deepEqual(supportSearchPlan("4f2a-9c7k"), { kind: "reference", reference: "B0-4F2A-9C7K" });
  // An eight-letter name is a name.
  assert.deepEqual(supportSearchPlan("Marthajs"), { kind: "text", pattern: "%Marthajs%" });
  assert.deepEqual(supportSearchPlan("alex@example.com"), { kind: "text", pattern: "%alex@example.com%" });
  // LIKE metacharacters match literally.
  assert.deepEqual(supportSearchPlan("100%_off"), { kind: "text", pattern: "%100\\%\\_off%" });
  assert.deepEqual(supportSearchPlan("a*b"), { kind: "text", pattern: "%a b%" });
  assert.equal(supportSearchPlan("   "), null);
  assert.equal(supportSearchPlan(undefined), null);
  assert.equal(
    (supportSearchPlan("x".repeat(500)) as { pattern: string }).pattern.length,
    102,
    "capped at 100 characters plus the two wildcards",
  );
});

test("the search filter quotes what PostgREST reserves", () => {
  assert.equal(escapeLikePattern("a\\b%c_d"), "a\\\\b\\%c\\_d");
  assert.equal(
    ilikeAnyFilter(["requester_email", "subject"], "%alex@example.com%"),
    'requester_email.ilike."%alex@example.com%",subject.ilike."%alex@example.com%"',
  );
  assert.equal(
    ilikeAnyFilter(["subject"], '%say "hi", (please)\\_x%'),
    'subject.ilike."%say \\"hi\\", (please)\\\\_x%"',
  );
});

// ---------------------------------------------------------------------------
// The vocabulary is complete
// ---------------------------------------------------------------------------

test("every category, status, priority, channel and outcome has copy", () => {
  for (const c of TICKET_CATEGORIES) {
    assert.ok(CATEGORY_LABELS[c]?.length > 0, `${c} needs a label`);
    assert.ok(CATEGORY_HINTS[c]?.length > 0, `${c} needs a hint`);
  }
  for (const s of TICKET_STATUSES) {
    assert.ok(STATUS_LABELS[s]?.length > 0, `${s} needs a requester label`);
    assert.ok(STAFF_STATUS_LABELS[s]?.length > 0, `${s} needs a staff label`);
  }
  for (const p of TICKET_PRIORITIES) {
    assert.ok(PRIORITY_LABELS[p]?.length > 0, p);
    assert.equal(typeof PRIORITY_RANK[p], "number", p);
  }
  for (const ch of TICKET_CHANNELS) assert.ok(CHANNEL_LABELS[ch]?.length > 0, ch);
  for (const o of TICKET_OUTCOMES) assert.ok(OUTCOME_LABELS[o]?.length > 0, o);
  assert.ok(STAFF_LOG_CHANNELS.every((c) => (TICKET_CHANNELS as readonly string[]).includes(c)));
});

test("the picker's groups hold every category exactly once, in display order", () => {
  const flat = CATEGORY_GROUPS.flatMap((g) => g.categories);
  assert.deepEqual(flat, [...TICKET_CATEGORIES]);
});

test("priorities rank urgent over high over normal over low", () => {
  const byRank = [...TICKET_PRIORITIES].sort((a, b) => PRIORITY_RANK[b] - PRIORITY_RANK[a]);
  assert.deepEqual(byRank, ["urgent", "high", "normal", "low"]);
});

test("the refund hint doesn't promise what the refund policy refuses", () => {
  // Demo Day tickets are final sale unless batch0 cancels Demo Day.
  assert.match(CATEGORY_HINTS.refund, /final sale/);
  assert.match(CATEGORY_HINTS.refund, /48 hours/);
  // There is no self-serve deletion; the hint must not imply one.
  assert.match(CATEGORY_HINTS.privacy, /no self-serve deletion/);
});

test("the requester's status wording is second-person where it differs", () => {
  assert.equal(STATUS_LABELS.waiting_on_requester, "Waiting on you");
  assert.equal(STAFF_STATUS_LABELS.waiting_on_requester, "Waiting on requester");
});

test("the auto-resolve note states the same number of days as the cron", () => {
  assert.match(AUTO_RESOLVE_NOTE, new RegExp(`after ${AUTO_RESOLVE_AFTER_DAYS} days`));
});

// ---------------------------------------------------------------------------
// The TypeScript vocabularies match the database's CHECKs
// ---------------------------------------------------------------------------

test("each vocabulary is exactly the list its CHECK in 0090 allows", () => {
  // A value the TS accepts and the database refuses is an insert that fails at
  // runtime only for the option nobody tested; a value the database allows and
  // the TS doesn't know is a row the UI can't render. Set equality, both ways.
  assert.deepEqual(
    sqlList(/add constraint support_tickets_category_check\s+check \(category in \(([^)]*)\)\)/),
    sorted(TICKET_CATEGORIES),
  );
  assert.deepEqual(
    sqlList(/add constraint support_tickets_priority_check\s+check \(priority in \(([^)]*)\)\)/),
    sorted(TICKET_PRIORITIES),
  );
  assert.deepEqual(
    sqlList(/add constraint support_tickets_channel_check\s+check \(channel in \(([^)]*)\)\)/),
    sorted(TICKET_CHANNELS),
  );
  assert.deepEqual(
    sqlList(/add constraint support_tickets_outcome_check\s+check \(outcome is null or outcome in \(([^)]*)\)\)/),
    sorted(TICKET_OUTCOMES),
  );
  assert.deepEqual(
    sqlList(/status text not null default 'open'\s+check \(status in \(([^)]*)\)\)/),
    sorted(TICKET_STATUSES),
  );
  assert.deepEqual(
    sqlList(/add constraint support_ticket_replies_via_check\s+check \(via in \(([^)]*)\)\)/),
    sorted(REPLY_VIAS),
  );
});

test("the length caps are the ones migration 0090 enforces", () => {
  assert.match(
    SQL,
    new RegExp(`subject text not null check \\(char_length\\(subject\\) between 1 and ${TICKET_SUBJECT_MAX}\\)`),
  );
  assert.match(
    SQL,
    new RegExp(`body text not null check \\(char_length\\(body\\) between ${TICKET_BODY_MIN} and ${TICKET_BODY_MAX}\\)`),
  );
  assert.match(
    SQL,
    new RegExp(`body text not null check \\(char_length\\(body\\) between 1 and ${REPLY_BODY_MAX}\\)`),
    "the reply cap is the one on support_ticket_replies, which has no minimum",
  );
  assert.ok(TICKET_BODY_MIN < TICKET_BODY_MAX, "the minimum has to be reachable");
});

test("migration 0090 enforces the token and reference shapes too", () => {
  assert.match(SQL, /token text not null unique check \(token ~ '\^\[A-Za-z0-9_-\]\{43\}\$'\)/);
  assert.match(SQL, /reference \~ '\^B0-\[2-9A-HJKMNP-TV-Z\]\{4\}-\[2-9A-HJKMNP-TV-Z\]\{4\}\$'/);
});

// ---------------------------------------------------------------------------
// The tables are locked down
// ---------------------------------------------------------------------------

test("migration 0090 revokes the default grants and adds no requester write policy", () => {
  for (const table of ["support_tickets", "support_ticket_replies", "support_ticket_attachments"]) {
    assert.match(SQL, new RegExp(`revoke all on public\\.${table} from anon, authenticated;`));
    assert.match(SQL, new RegExp(`alter table public\\.${table} enable row level security;`));
  }
  // Writes are server-only so the server owns requester_email, is_staff, via,
  // is_internal, token and reference. A per-command policy would be a
  // requester write path; the only write policies are the staff `for all`.
  const policies = SQL.match(/create policy[^;]*;/gi) ?? [];
  assert.equal(policies.length, 6, "a read and a staff write policy per table");
  for (const policy of policies) {
    assert.match(policy, /\bfor (select|all)\b/i, policy.split("\n")[0]);
  }
  assert.match(SQL, /notify pgrst, 'reload schema';/);
});

test("internal notes and confidential concerns are hidden at the row level too", () => {
  // lib/support.ts defaults includeInternal to false and filters sensitive
  // tickets out of every staff read; the policies carry the same rules.
  const replyPolicy = /create policy "support_ticket_replies read"[\s\S]*?\);/.exec(SQL);
  assert.ok(replyPolicy, "the reply read policy must exist");
  assert.match(replyPolicy[0], /not support_ticket_replies\.is_internal/);
  assert.match(replyPolicy[0], /has_permission\(auth\.uid\(\), 'support\.view'\)/);
  assert.match(replyPolicy[0], /not t\.sensitive or public\.has_permission\(auth\.uid\(\), 'support\.sensitive'\)/);

  const ticketPolicy = /create policy "support_tickets read"[\s\S]*?\);/.exec(SQL);
  assert.ok(ticketPolicy);
  assert.match(ticketPolicy[0], /not sensitive or public\.has_permission\(auth\.uid\(\), 'support\.sensitive'\)/);
});

test("the rate limiter is locked to the service role, never forced", () => {
  assert.match(SQL, /revoke execute on function public\.rate_limit_check\(text, integer\) from public, anon, authenticated/);
  assert.ok(!/force row level security/i.test(SQL.replace(/^\s*--.*$/gm, "")));
});
