import test from "node:test";
import assert from "node:assert/strict";
import { ALL_PERMISSIONS, can, canViewAdminPath, capabilitiesFrom } from "./permissions.ts";
import {
  ATTENTION_LIMIT,
  ATTENTION_PERMITTED,
  ageSince,
  attentionEmptyText,
  chatReportItems,
  collectAttention,
  compareAttention,
  feedbackItems,
  followUpItems,
  ownerLabel,
  pickAttention,
  questionItems,
  QUESTION_STALE_MS,
  supportItems,
  type AttentionItem,
  type AttentionProvider,
  type AttentionSource,
  type AttentionSourceKey,
  type FollowUpLike,
  type QuestionLike,
  type SupportLike,
} from "./attention.ts";
import { canReadChannel } from "./chat-access.ts";

const ME = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";
const NOW = Date.parse("2026-10-17T16:00:00.000Z"); // 12:00 in New York
const TODAY = "2026-10-17";
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
const caps = (...permissions: string[]) => capabilitiesFrom("custom", permissions);

test("each source opens only to the permission of the page its rows open", () => {
  const sees = (c: ReturnType<typeof caps>) =>
    (Object.keys(ATTENTION_PERMITTED) as AttentionSourceKey[]).filter((k) => ATTENTION_PERMITTED[k](c)).sort();
  assert.deepEqual(sees(caps("support.view")), ["support"]);
  // /admin/support is gated on support.view; support.manage alone bounces
  // off the layout, so it doesn't open the source either.
  assert.deepEqual(sees(caps("support.manage")), []);
  assert.deepEqual(sees(caps("support.view", "support.manage")), ["support"]);
  // support.sensitive alone opens nothing, as in the Support policies.
  assert.deepEqual(sees(caps("support.sensitive")), []);
  assert.deepEqual(sees(caps("assignments.manage")), ["feedback"]);
  assert.deepEqual(sees(caps("mentor.panel")), ["feedback"]);
  // Chat staff read every text channel, so #help's questions open to them too (0110).
  assert.deepEqual(sees(caps("chat.manage")), ["chat_questions", "chat_reports"]);
  assert.deepEqual(sees(caps("people.view")), ["followups"]);
  assert.deepEqual(sees(caps("payments.view", "applications.view", "student.dashboard")), []);
  assert.deepEqual(sees(caps("*")), ["chat_questions", "chat_reports", "feedback", "followups", "support"]);
});

test("whoever sees a source can open every row's action — checked for every role of up to two keys", () => {
  const ID = "00000000-0000-4000-8000-0000000000aa";
  const support = supportItems(
    [{ id: ID, reference: "B0-1", subject: "s", needsReply: true, priority: "normal", sensitive: false, requesterActivityAt: hoursAgo(1), assignedTo: null, assignedName: null }],
    { userId: ME, canManage: true },
    NOW,
  );
  const sub = { id: ID, assignmentId: ID, userId: OTHER, submittedAt: hoursAgo(1), assignment: { title: "a", week: 1, cohortId: ID }, studentName: "s" };
  const reports = chatReportItems([{ id: ID, channelId: ID, partyIds: [], messageId: null, status: "open", createdAt: hoursAgo(1) }], new Map(), ME, NOW);
  const follow = followUpItems([{ id: ID, studentId: OTHER, studentName: "s", ownerId: null, ownerName: null, nextCheckOn: TODAY, status: "open" }], ME, TODAY);
  const questions = questionItems(
    [{ rootId: ID, channelId: ID, channelName: "help", askerName: "s", askedAt: hoursAgo(1), replyCount: 0, help: null }],
    NOW,
  );
  // Where a row's one action goes, given who's looking (the feedback link
  // depends on whether they review program-wide).
  const hrefs: Record<AttentionSourceKey, (c: ReturnType<typeof caps>) => string[]> = {
    support: () => [...support.map((r) => r.action.href), "/admin/support"],
    feedback: (c) => feedbackItems([sub], { userId: ME, manager: can(c, "assignments.manage") }, new Map(), NOW).map((r) => r.action.href),
    chat_reports: () => [...reports.map((r) => r.action.href), "/admin/chat"],
    chat_questions: () => [...questions.map((r) => r.action.href), `/chat?c=${ID}`],
    followups: () => [...follow.map((r) => r.action.href), "/admin/progress"],
  };
  // A #help thread opens to whoever reads #help; chat.manage reads every text
  // channel (lib/chat-access.ts canReadChannel), whatever the audience.
  const opens = (c: ReturnType<typeof caps>, href: string) => {
    const path = href.split(/[?#]/)[0];
    if (path === "/chat") return canReadChannel(
      { id: ID, kind: "channel", audience: "staff", cohortId: null, teamId: null, posting: "everyone", archivedAt: null, slowmodeSeconds: 0 },
      { userId: ME, staff: can(c, "chat.manage"), vetted: false, cohortIds: [], teamIds: [], memberOf: [] },
      false,
    );
    return path.startsWith("/admin") ? canViewAdminPath(c, path) : path.startsWith("/mentor") ? can(c, "mentor.panel") : false;
  };
  const roles: string[][] = [];
  for (const a of ALL_PERMISSIONS) {
    roles.push([a]);
    for (const b of ALL_PERMISSIONS) if (a < b) roles.push([a, b]);
  }
  for (const perms of roles) {
    const c = caps(...perms);
    for (const key of Object.keys(ATTENTION_PERMITTED) as AttentionSourceKey[]) {
      if (!ATTENTION_PERMITTED[key](c)) continue;
      for (const href of hrefs[key](c)) assert.ok(opens(c, href), `${perms.join("+")} sees ${key} but can't open ${href}`);
    }
  }
});

function item(source: AttentionSourceKey, n: number, over: Partial<AttentionItem> = {}): AttentionItem {
  return {
    key: `${source}:${n}`,
    source,
    reason: "r",
    context: "c",
    since: hoursAgo(n),
    age: "",
    urgency: "waiting",
    owner: { kind: "nobody" },
    action: { label: "Open", href: `/x/${n}` },
    ...over,
  };
}

function provider(
  key: AttentionSourceKey,
  calls: string[],
  load: () => Promise<AttentionSource | null>,
): AttentionProvider<{ who: string }> {
  return {
    key,
    permitted: ATTENTION_PERMITTED[key],
    load: async (ctx) => {
      calls.push(`${key}:${ctx.who}`);
      return load();
    },
  };
}

const source = (key: AttentionSourceKey, items: AttentionItem[], total = items.length): AttentionSource => ({
  key,
  label: key,
  total,
  href: `/${key}`,
  items,
});

test("a source the viewer can't open is never read — not its rows, not its count", async () => {
  const calls: string[] = [];
  const providers = [
    provider("support", calls, async () => source("support", [item("support", 1)])),
    provider("chat_reports", calls, async () => source("chat_reports", [item("chat_reports", 2)])),
    provider("followups", calls, async () => source("followups", [item("followups", 3)])),
  ];
  const r = await collectAttention(caps("people.view"), providers, { who: ME });
  assert.deepEqual(calls, [`followups:${ME}`]);
  assert.deepEqual(r.sources.map((s) => s.key), ["followups"]);
  assert.deepEqual(r.rows.map((x) => x.key), ["followups:3"]);
  // Signed out (no capabilities): nothing runs at all.
  calls.length = 0;
  assert.deepEqual(await collectAttention(null, providers, { who: ME }), { sources: [], rows: [], failed: [] });
  assert.deepEqual(calls, []);
});

test("a failing source is named, not shown as empty; one not set up yet is just absent", async () => {
  const calls: string[] = [];
  const r = await collectAttention(
    caps("*"),
    [
      provider("support", calls, async () => {
        throw new Error("timeout");
      }),
      provider("feedback", calls, async () => null),
      provider("chat_reports", calls, async () => source("chat_reports", [item("chat_reports", 1)])),
    ],
    { who: ME },
  );
  assert.deepEqual(r.failed, ["support"]);
  assert.deepEqual(r.sources.map((s) => s.key), ["chat_reports"]);
  assert.equal(r.rows.length, 1);
});

test("'nothing waiting' only when every source that loaded is empty and none failed", () => {
  const result = (sources: AttentionSource[], failed: AttentionSourceKey[] = []) => ({
    sources,
    rows: pickAttention(sources.flatMap((s) => s.items)),
    failed,
  });
  assert.equal(attentionEmptyText(result([source("support", []), source("followups", [])])), "Nothing is waiting on the team.");
  // Two confidential requests, counted but never rows: something IS waiting.
  const confidential = { ...source("support", [], 2), note: { text: "2 confidential requests need a reply.", href: "/admin/support" } };
  assert.equal(attentionEmptyText(result([confidential, source("followups", [])])), null);
  // A source that couldn't be read may have work in it.
  assert.equal(attentionEmptyText(result([source("followups", [])], ["feedback"])), "Nothing waiting in the lists that loaded.");
  // Rows to show, or no source at all: the list says nothing of the kind.
  assert.equal(attentionEmptyText(result([source("followups", [item("followups", 1)])])), null);
  assert.equal(attentionEmptyText(result([], ["support"])), null);
});

test("a provider can't slip rows in under another source's name", async () => {
  const r = await collectAttention(
    caps("people.view"),
    [provider("followups", [], async () => source("followups", [item("followups", 1), item("support", 2)]))],
    { who: ME },
  );
  assert.deepEqual(r.rows.map((x) => x.key), ["followups:1"]);
});

test("rows: overdue, then due, then waiting; oldest first within each", () => {
  const rows = [
    item("feedback", 50),
    item("support", 2, { urgency: "overdue" }),
    item("chat_reports", 1, { urgency: "due" }),
    item("support", 9, { urgency: "overdue" }),
    item("feedback", 70),
  ].sort(compareAttention);
  assert.deepEqual(rows.map((r) => r.key), ["support:9", "support:2", "chat_reports:1", "feedback:70", "feedback:50"]);
});

test(`at most ${ATTENTION_LIMIT} rows, and every source with work keeps its most pressing one`, () => {
  const support = Array.from({ length: 40 }, (_, i) => item("support", i + 1, { urgency: "overdue" }));
  const picked = pickAttention([...support, item("feedback", 200), item("followups", 3, { urgency: "due" })]);
  assert.equal(picked.length, ATTENTION_LIMIT);
  assert.ok(picked.some((r) => r.key === "feedback:200"), "the week-old submission isn't buried by forty requests");
  assert.ok(picked.some((r) => r.key === "followups:3"));
  assert.deepEqual([...picked].sort(compareAttention), picked, "still in order");
  // The rest of the slots are the most overdue support requests.
  assert.deepEqual(
    picked.filter((r) => r.source === "support").map((r) => r.key),
    ["support:40", "support:39", "support:38", "support:37", "support:36", "support:35"],
  );
  assert.deepEqual(pickAttention([item("support", 1)], 0), []);
  assert.equal(pickAttention([item("support", 1), item("support", 2)], 10).length, 2);
});

const ticket = (over: Partial<SupportLike> = {}): SupportLike => ({
  id: "t1",
  reference: "B0-2345-6789",
  subject: "Refund for the spring cohort",
  needsReply: true,
  priority: "normal",
  sensitive: false,
  requesterActivityAt: hoursAgo(5),
  assignedTo: null,
  assignedName: null,
  ...over,
});

test("support: a confidential request is never a row, whoever is looking", () => {
  const rows = supportItems(
    [ticket({ id: "c1", sensitive: true, priority: "urgent", subject: "Something happened in my team" }), ticket({ id: "t2" })],
    { userId: ME, canManage: true },
    NOW,
  );
  assert.deepEqual(rows.map((r) => r.key), ["support:t2"]);
  assert.ok(!JSON.stringify(rows).includes("Something happened"));
});

test("support: answering a request takes its row off", () => {
  assert.equal(supportItems([ticket({ needsReply: false })], { userId: ME, canManage: true }, NOW).length, 0);
});

test("support: reason from the reply target, owner, age and the one next action", () => {
  const [fresh] = supportItems([ticket()], { userId: ME, canManage: true }, NOW);
  assert.equal(fresh.reason, "Needs a reply");
  assert.equal(fresh.urgency, "waiting");
  assert.deepEqual(fresh.owner, { kind: "nobody" });
  assert.equal(ownerLabel(fresh.owner), "No owner");
  assert.deepEqual(fresh.action, { label: "Assign", href: "/admin/support/t1" });
  assert.equal(fresh.age, "5h 0m");
  assert.equal(fresh.context, "B0-2345-6789 · Refund for the spring cohort");

  // Normal is 48h: 40h in is due soon, 49h is overdue.
  const [soon] = supportItems([ticket({ requesterActivityAt: hoursAgo(40) })], { userId: ME, canManage: true }, NOW);
  assert.equal(soon.reason, "Reply due soon");
  assert.equal(soon.urgency, "due");
  const [late] = supportItems(
    [ticket({ requesterActivityAt: hoursAgo(49), assignedTo: ME, assignedName: "Ada" })],
    { userId: ME, canManage: true },
    NOW,
  );
  assert.equal(late.reason, "Reply overdue");
  assert.equal(late.urgency, "overdue");
  assert.equal(late.action.label, "Reply");
  assert.equal(ownerLabel(late.owner), "You");
  const [theirs] = supportItems([ticket({ assignedTo: OTHER, assignedName: "Grace" })], { userId: ME, canManage: true }, NOW);
  assert.equal(ownerLabel(theirs.owner), "Grace");

  // Read-only support: the action only opens it.
  const [readOnly] = supportItems([ticket()], { userId: ME, canManage: false }, NOW);
  assert.equal(readOnly.action.label, "Open");
});

const submission = (over: Record<string, unknown> = {}) => ({
  id: "s1",
  assignmentId: "a1",
  userId: "u1",
  submittedAt: hoursAgo(30),
  assignment: { title: "Weekly update", week: 4, cohortId: "c1" },
  studentName: "Ada Lovelace",
  ...over,
});

test("feedback: waiting work, linked to the admin drawer or the mentor queue", () => {
  const none = new Map();
  const [admin] = feedbackItems([submission()], { userId: ME, manager: true }, none, NOW);
  assert.equal(admin.reason, "Waiting for feedback");
  assert.equal(admin.context, "Ada Lovelace · Weekly update · Week 4");
  assert.equal(admin.action.href, "/admin/assignments?cohort=c1&review=a1:u1");
  assert.equal(ownerLabel(admin.owner), "Any reviewer");
  assert.equal(admin.age, "30h 0m");
  const [mentor] = feedbackItems([submission()], { userId: ME, manager: false }, none, NOW);
  assert.equal(mentor.action.href, "/mentor/assignments#submission-s1");
  // Reviewing (or returning, or excusing) it takes the row off.
  assert.equal(feedbackItems([submission({ status: "reviewed" })], { userId: ME, manager: true }, none, NOW).length, 0);
  assert.equal(feedbackItems([submission({ status: "returned" })], { userId: ME, manager: true }, none, NOW).length, 0);
});

test("feedback: the owner is the student's mentor", () => {
  const one = new Map([["u1", [{ id: OTHER, name: "Grace" }]]]);
  assert.equal(ownerLabel(feedbackItems([submission()], { userId: ME, manager: true }, one, NOW)[0].owner), "Grace");
  const mine = new Map([["u1", [{ id: OTHER, name: "Grace" }, { id: ME, name: "Ada" }]]]);
  assert.equal(ownerLabel(feedbackItems([submission()], { userId: ME, manager: false }, mine, NOW)[0].owner), "You +1");
});

const report = (over: Record<string, unknown> = {}) => ({
  id: "r1",
  channelId: "ch1",
  partyIds: [OTHER],
  messageId: "m1",
  status: "open",
  createdAt: hoursAgo(3),
  ...over,
});

test("chat reports: where, never who reported or why; a report about the viewer never shows", () => {
  const channels = new Map([
    ["ch1", { kind: "channel" as const, name: "help" }],
    ["dm1", { kind: "dm" as const, name: null }],
  ]);
  const rows = chatReportItems(
    [
      report(),
      report({ id: "r2", channelId: "dm1", messageId: null }),
      report({ id: "r3", partyIds: [ME, OTHER] }),
      report({ id: "r4", channelId: "gone" }),
    ],
    channels,
    ME,
    NOW,
  );
  assert.deepEqual(rows.map((r) => r.key), ["chat_reports:r1", "chat_reports:r2", "chat_reports:r4"]);
  assert.deepEqual(rows.map((r) => r.context), ["Message in #help", "Conversation in a direct message", "Message in a deleted channel"]);
  assert.deepEqual(rows[0].action, { label: "Review", href: "/admin/chat/reports/r1" });
  assert.equal(ownerLabel(rows[0].owner), "Moderators");
  assert.equal(rows[0].urgency, "due");
  // Actioning or dismissing it takes the row off.
  assert.equal(chatReportItems([report({ status: "actioned" }), report({ status: "dismissed" })], channels, ME, NOW).length, 0);
});

test("chat reports: a report the viewer filed is left for another moderator", () => {
  const channels = new Map([["ch1", { kind: "channel" as const, name: "help" }]]);
  const rows = chatReportItems(
    [report({ id: "mine", reporterId: ME }), report({ id: "theirs", reporterId: OTHER }), report({ id: "gone", reporterId: null })],
    channels,
    ME,
    NOW,
  );
  assert.deepEqual(rows.map((r) => r.key), ["chat_reports:theirs", "chat_reports:gone"]);
});

const followUp = (over: Partial<FollowUpLike> = {}): FollowUpLike => ({
  id: "f1",
  studentId: "u1",
  studentName: "Ada Lovelace",
  ownerId: OTHER,
  ownerName: "Grace",
  nextCheckOn: TODAY,
  status: "open",
  ...over,
});

test("follow-ups: due today or earlier shows, with its owner; later or closed doesn't", () => {
  const rows = followUpItems(
    [
      followUp(),
      followUp({ id: "f2", nextCheckOn: "2026-10-14", ownerId: ME, ownerName: "Ada" }),
      followUp({ id: "f3", nextCheckOn: "2026-10-18" }),
      followUp({ id: "f4", status: "closed", nextCheckOn: "2026-10-10" }),
      followUp({ id: "f5", ownerId: null, ownerName: null, nextCheckOn: "2026-10-16" }),
    ],
    ME,
    TODAY,
  );
  assert.deepEqual(rows.map((r) => r.key), ["followups:f1", "followups:f2", "followups:f5"]);
  const [today, late, orphan] = rows;
  assert.equal(today.reason, "Follow-up check due");
  assert.equal(today.urgency, "due");
  assert.equal(today.age, "Due today");
  assert.equal(ownerLabel(today.owner), "Grace");
  assert.deepEqual(today.action, { label: "Open", href: "/admin/progress?followup=u1" });
  assert.equal(late.reason, "Follow-up check overdue");
  assert.equal(late.urgency, "overdue");
  assert.equal(late.age, "3 days late");
  assert.equal(ownerLabel(late.owner), "You");
  assert.equal(orphan.age, "1 day late");
  assert.equal(ownerLabel(orphan.owner), "No owner");
  // The wait starts at midnight in New York on the due day (04:00 UTC in October).
  assert.equal(today.since, "2026-10-17T04:00:00.000Z");
});

test("nothing on the list guesses at how a student is doing", () => {
  const all = [
    ...supportItems([ticket()], { userId: ME, canManage: true }, NOW),
    ...feedbackItems([submission()], { userId: ME, manager: true }, new Map(), NOW),
    ...chatReportItems([report()], new Map(), ME, NOW),
    ...followUpItems([followUp()], ME, TODAY),
  ];
  for (const r of all) assert.doesNotMatch(r.reason, /risk|stall|inactive|disengag|motivat|struggl|wellbeing/i);
});

test("ages never read as zero", () => {
  assert.equal(ageSince(new Date(NOW).toISOString(), NOW), "1m");
  assert.equal(ageSince(hoursAgo(80), NOW), "3d 8h");
  assert.equal(ageSince("not a date", NOW), "1m");
});

test("unanswered questions: oldest-waiting rows naming the channel and the asker, never the words; a help request still open is Support's row", () => {
  const q = (over: Partial<QuestionLike>): QuestionLike => ({
    rootId: "q", channelId: "help-id", channelName: "help", askerName: "Maya Chen", askedAt: hoursAgo(2), replyCount: 0, help: null, ...over,
  });
  const rows = questionItems(
    [
      q({ rootId: "stale", askedAt: new Date(NOW - QUESTION_STALE_MS - 60_000).toISOString() }),
      q({ rootId: "fresh", askedAt: hoursAgo(2) }),
      q({ rootId: "replied", replyCount: 3, askedAt: hoursAgo(30) }),
      // Someone asked the team about these: the open request is the row (Support), not the question.
      q({ rootId: "helped", help: { status: "open", assigneeName: "Rish" } }),
      q({ rootId: "waiting", help: { status: "waiting_on_requester", assigneeName: null } }),
      // A handled request with the question still open: the question is back on the list.
      q({ rootId: "handled", help: { status: "resolved", assigneeName: "Rish" } }),
    ],
    NOW,
  );
  assert.deepEqual(rows.map((r) => r.key), ["chat_questions:stale", "chat_questions:fresh", "chat_questions:replied", "chat_questions:handled"]);
  const [stale, fresh, replied] = rows;
  assert.deepEqual([stale.reason, stale.urgency], ["No reply in 24 hours", "overdue"]);
  assert.deepEqual([fresh.reason, fresh.urgency], ["No reply yet", "waiting"]);
  assert.deepEqual([replied.reason, replied.urgency, replied.action.label], ["Not marked answered", "waiting", "Open"]);
  assert.equal(stale.context, "#help · Maya Chen", "where and who asked, nothing of what they wrote");
  assert.deepEqual(stale.action, { label: "Answer", href: "/chat?c=help-id&thread=stale" });
  assert.deepEqual(stale.owner, { kind: "team", label: "Anyone on the team" });
  // Answered (or no longer a question) means it isn't loaded at all; the provider reads open questions only.
  assert.deepEqual(questionItems([], NOW), []);
  // An overdue question outranks the queue's waiting rows.
  assert.equal(pickAttention([...rows], 2)[0].key, "chat_questions:stale");
});
