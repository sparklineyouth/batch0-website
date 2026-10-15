import test from "node:test";
import assert from "node:assert/strict";
import {
  attentionFor,
  badgeText,
  BELL_QUIET_MS,
  canDeleteMessage,
  canEditMessage,
  canManageChannel,
  canMentionEveryone,
  canPin,
  canPost,
  canReadChannel,
  canStartGroup,
  conversationAllowed,
  SAFEGUARD_REASON,
  GROUP_MAX_MEMBERS,
  compareChannels,
  compareConversations,
  dmKey,
  effectiveNotify,
  groupDisplayName,
  isAfter,
  isAllowedReaction,
  isConversationVisible,
  isUuid,
  laterTimestamp,
  normalizeChannelName,
  otherInDmKey,
  reportOpenTo,
  reportVisibleTo,
  shouldBell,
  slowModeWait,
  sortedReactions,
  toggleReaction,
  wantsBell,
  CHANNEL_NAME_PATTERN,
  type ChannelScope,
  type ChatViewer,
} from "./chat-access.ts";

const ME = "11111111-1111-4111-8111-111111111111";
const YOU = "22222222-2222-4222-8222-222222222222";
const COHORT = "33333333-3333-4333-8333-333333333333";
const TEAM = "44444444-4444-4444-8444-444444444444";

function channel(over: Partial<ChannelScope> = {}): ChannelScope {
  return {
    id: "c1",
    kind: "channel",
    audience: "everyone",
    cohortId: null,
    teamId: null,
    posting: "everyone",
    archivedAt: null,
    slowmodeSeconds: 0,
    ...over,
  };
}

function viewer(over: Partial<ChatViewer> = {}): ChatViewer {
  return { userId: ME, staff: false, vetted: true, cohortIds: [], teamIds: [], memberOf: [], ...over };
}

test("everyone channels: vetted people and staff read, fresh signups don't", () => {
  const c = channel();
  assert.equal(canReadChannel(c, viewer(), false), true);
  assert.equal(canReadChannel(c, viewer({ vetted: false }), false), false);
  assert.equal(canReadChannel(c, viewer({ vetted: false, staff: true }), false), true);
});

test("cohort and team channels follow enrollment and membership", () => {
  const cohort = channel({ audience: "cohort", cohortId: COHORT });
  const team = channel({ audience: "team", teamId: TEAM });
  assert.equal(canReadChannel(cohort, viewer({ cohortIds: [COHORT] }), false), true);
  assert.equal(canReadChannel(cohort, viewer(), false), false);
  assert.equal(canReadChannel(team, viewer({ teamIds: [TEAM] }), false), true);
  assert.equal(canReadChannel(team, viewer({ cohortIds: [COHORT] }), false), false);
  assert.equal(canReadChannel(team, viewer({ staff: true }), false), true);
});

test("staff and private channels: staff and explicit members only", () => {
  for (const audience of ["staff", "members"] as const) {
    const c = channel({ audience });
    assert.equal(canReadChannel(c, viewer(), false), false);
    assert.equal(canReadChannel(c, viewer({ staff: true }), false), true);
    assert.equal(canReadChannel(c, viewer({ memberOf: ["c1"] }), false), true);
  }
});

test("an explicit member reads a channel outside its audience", () => {
  const cohort = channel({ audience: "cohort", cohortId: COHORT });
  assert.equal(canReadChannel(cohort, viewer({ memberOf: ["c1"] }), false), true);
});

test("DMs: members always, staff only once reported", () => {
  const dm = channel({ kind: "dm", audience: "members" });
  assert.equal(canReadChannel(dm, viewer({ memberOf: ["c1"] }), false), true);
  assert.equal(canReadChannel(dm, viewer({ staff: true }), false), false);
  assert.equal(canReadChannel(dm, viewer({ staff: true }), true), true);
  assert.equal(canReadChannel(dm, viewer(), true), false);
});

test("nobody without an id reads anything", () => {
  assert.equal(canReadChannel(channel(), viewer({ userId: "", staff: true }), false), false);
});

test("posting: archived, staff-only and moderator views are read-only", () => {
  assert.deepEqual(canPost(channel(), viewer()), { ok: true });
  assert.equal(canPost(channel({ archivedAt: "2026-10-01T00:00:00Z" }), viewer({ staff: true })).ok, false);
  const ann = channel({ posting: "staff" });
  assert.equal(canPost(ann, viewer()).ok, false);
  assert.equal(canPost(ann, viewer({ staff: true })).ok, true);
  const dm = channel({ kind: "dm", audience: "members" });
  assert.equal(canPost(dm, viewer({ staff: true }), { reported: true }).ok, false);
  assert.equal(canPost(channel({ audience: "staff" }), viewer()).ok, false);
});

test("DMs freeze on a block and go read-only when the other side is gone", () => {
  const dm = channel({ kind: "dm", audience: "members" });
  const me = viewer({ memberOf: ["c1"] });
  assert.equal(canPost(dm, me, { otherPresent: true }).ok, true);
  const blocked = canPost(dm, me, { blocked: true, otherPresent: true });
  assert.equal(blocked.ok, false);
  assert.ok(!blocked.ok && !/blocked you|you blocked/i.test(blocked.reason));
  assert.equal(canPost(dm, me, { otherPresent: false }).ok, false);
  // Groups ignore both: blocks hide messages there instead.
  const group = channel({ kind: "group", audience: "members" });
  assert.equal(canPost(group, me, { blocked: true }).ok, true);
});

test("managing, pinning and @everyone", () => {
  const c = channel();
  const group = channel({ kind: "group", audience: "members" });
  const dm = channel({ kind: "dm", audience: "members" });
  const member = viewer({ memberOf: ["c1"] });
  assert.equal(canManageChannel(c, viewer()), false);
  assert.equal(canManageChannel(c, viewer({ staff: true })), true);
  assert.equal(canManageChannel(group, member), true);
  assert.equal(canManageChannel(dm, member), false);
  assert.equal(canPin(c, member), false);
  assert.equal(canPin(c, viewer({ staff: true })), true);
  assert.equal(canPin(dm, member), true);
  assert.equal(canMentionEveryone(c, viewer({ staff: true })), true);
  assert.equal(canMentionEveryone(c, viewer()), false);
  assert.equal(canMentionEveryone(group, viewer({ staff: true })), false);
});

test("editing and deleting messages", () => {
  const mine = { senderId: ME, kind: "message" as const, deletedAt: null };
  const theirs = { senderId: YOU, kind: "message" as const, deletedAt: null };
  const system = { senderId: null, kind: "system" as const, deletedAt: null };
  assert.equal(canEditMessage(mine, viewer()), true);
  assert.equal(canEditMessage(theirs, viewer()), false);
  assert.equal(canEditMessage(theirs, viewer({ staff: true })), false);
  assert.equal(canEditMessage(system, viewer({ staff: true })), false);
  assert.equal(canEditMessage({ ...mine, deletedAt: "x" }, viewer()), false);
  const c = channel();
  assert.equal(canDeleteMessage(mine, c, viewer()), true);
  assert.equal(canDeleteMessage(theirs, c, viewer()), false);
  assert.equal(canDeleteMessage(theirs, c, viewer({ staff: true })), true);
  assert.equal(canDeleteMessage(system, c, viewer()), false);
  assert.equal(canDeleteMessage({ ...mine, deletedAt: "x" }, c, viewer()), false);
  // A moderator looking into a reported DM may remove what was said in it;
  // a moderator who is one side of a DM may not wipe the other side.
  const dm = channel({ id: "d1", kind: "dm", audience: "members" });
  assert.equal(canDeleteMessage(theirs, dm, viewer({ staff: true })), true);
  assert.equal(canDeleteMessage(theirs, dm, viewer({ staff: true, memberOf: ["d1"] })), false);
  assert.equal(canDeleteMessage(mine, dm, viewer({ staff: true, memberOf: ["d1"] })), true);
  assert.equal(canDeleteMessage(theirs, { ...dm, kind: "group" }, viewer({ staff: true, memberOf: ["d1"] })), false);
  // Membership in a text channel changes nothing for staff.
  assert.equal(canDeleteMessage(theirs, c, viewer({ staff: true, memberOf: ["c1"] })), true);
});

test("a report is never shown to someone it's about", () => {
  const staff = viewer({ staff: true });
  assert.equal(reportOpenTo([YOU], staff), true);
  assert.equal(reportOpenTo([ME, YOU], staff), false, "a party to the conversation");
  assert.equal(reportOpenTo([], viewer()), false, "not staff");
  assert.equal(reportOpenTo([], viewer({ staff: true, userId: "" })), false);
  const dmReport = { channelId: "d1", partyIds: [YOU] };
  assert.equal(reportVisibleTo(dmReport, "dm", staff), true);
  assert.equal(reportVisibleTo(dmReport, "dm", { ...staff, memberOf: ["d1"] }), false, "joined after the report");
  assert.equal(reportVisibleTo({ channelId: "c1", partyIds: [YOU] }, "channel", { ...staff, memberOf: ["c1"] }), true);
  assert.equal(reportVisibleTo({ channelId: "c1", partyIds: [ME] }, "channel", staff), false, "sent the reported message");
  // The read rule follows: a party's `reported` is false, so no read path.
  const dm = channel({ id: "d1", kind: "dm", audience: "members" });
  assert.equal(canReadChannel(dm, staff, reportOpenTo([ME, YOU], staff)), false);
  assert.equal(canReadChannel(dm, staff, reportOpenTo([YOU], staff)), true);
});

test("dmKey is order-independent and refuses a DM with yourself", () => {
  assert.equal(dmKey(ME, YOU), dmKey(YOU, ME));
  assert.equal(dmKey(YOU, ME), `${ME}:${YOU}`);
  assert.throws(() => dmKey(ME, ME));
  assert.equal(otherInDmKey(dmKey(ME, YOU), ME), YOU);
  assert.equal(otherInDmKey(dmKey(ME, YOU), YOU), ME);
  assert.equal(otherInDmKey(dmKey(ME, YOU), "someone"), null);
  assert.equal(otherInDmKey("legacy:abc", ME), null);
});

test("group names fall back to the other members", () => {
  const people = [
    { id: ME, name: "Me" },
    { id: "a", name: "Ann" },
    { id: "b", name: "Bo" },
    { id: "c", name: "Cy" },
    { id: "d", name: "Di" },
  ];
  assert.equal(groupDisplayName("Launch crew", people, ME), "Launch crew");
  assert.equal(groupDisplayName(null, people.slice(0, 3), ME), "Ann, Bo");
  assert.equal(groupDisplayName("  ", people, ME), "Ann, Bo, Cy +1");
  assert.equal(groupDisplayName(null, [people[0]], ME), "Just you");
});

test("slow mode: waits out the window, exempts staff and DMs", () => {
  const c = channel({ slowmodeSeconds: 30 });
  const now = Date.parse("2026-10-15T12:00:30Z");
  assert.equal(slowModeWait(c, viewer(), "2026-10-15T12:00:10Z", now), 10);
  assert.equal(slowModeWait(c, viewer(), "2026-10-15T11:00:00Z", now), 0);
  assert.equal(slowModeWait(c, viewer(), null, now), 0);
  assert.equal(slowModeWait(c, viewer({ staff: true }), "2026-10-15T12:00:29Z", now), 0);
  assert.equal(slowModeWait({ ...c, kind: "dm" }, viewer(), "2026-10-15T12:00:29Z", now), 0);
});

test("notification defaults: everything in DMs, mentions in channels", () => {
  assert.equal(effectiveNotify("dm", null), "all");
  assert.equal(effectiveNotify("group", undefined), "all");
  assert.equal(effectiveNotify("channel", null), "mentions");
  assert.equal(effectiveNotify("channel", "all"), "all");
  assert.equal(wantsBell("channel", null, false), false);
  assert.equal(wantsBell("channel", null, true), true);
  assert.equal(wantsBell("dm", null, false), true);
  assert.equal(wantsBell("dm", "none", true), false);
  assert.equal(wantsBell("group", "mentions", false), false);
});

test("one bell per burst", () => {
  const now = Date.parse("2026-10-15T12:00:00Z");
  assert.equal(shouldBell({ recipientSeenAt: null, hasUnreadBell: false }, now), true);
  assert.equal(shouldBell({ recipientSeenAt: null, hasUnreadBell: true }, now), false);
  const recent = new Date(now - BELL_QUIET_MS + 1000).toISOString();
  const stale = new Date(now - BELL_QUIET_MS - 1000).toISOString();
  assert.equal(shouldBell({ recipientSeenAt: recent, hasUnreadBell: false }, now), false);
  assert.equal(shouldBell({ recipientSeenAt: stale, hasUnreadBell: false }, now), true);
});

test("laterTimestamp compares instants, then microseconds as strings", () => {
  assert.equal(laterTimestamp("2026-10-15T12:00:00Z", "2026-10-15T11:00:00Z"), "2026-10-15T12:00:00Z");
  assert.equal(
    laterTimestamp("2026-10-15T12:00:00.123456+00:00", "2026-10-15T12:00:00.123+00:00"),
    "2026-10-15T12:00:00.123456+00:00",
  );
  assert.equal(laterTimestamp("garbage", "2026-10-15T12:00:00Z"), "2026-10-15T12:00:00Z");
  assert.equal(isAfter("2026-10-15T12:00:01Z", "2026-10-15T12:00:00Z"), true);
  assert.equal(isAfter("2026-10-15T12:00:00Z", "2026-10-15T12:00:00Z"), false);
});

test("badges cap at 99+", () => {
  assert.equal(badgeText(0), "");
  assert.equal(badgeText(7), "7");
  assert.equal(badgeText(140), "99+");
});

test("channel names normalize to the constraint's shape", () => {
  for (const [input, out] of [
    ["General", "general"],
    ["Fall 2026 — Team A!", "fall-2026-team-a"],
    ["  --café crème--  ", "cafe-creme"],
    ["x".repeat(100), "x".repeat(80)],
  ] as const) {
    assert.equal(normalizeChannelName(input), out);
    assert.match(normalizeChannelName(input), CHANNEL_NAME_PATTERN);
  }
  assert.equal(normalizeChannelName("!!!"), "");
});

test("reactions: palette only, sorted by count, toggled immutably", () => {
  assert.equal(isAllowedReaction("🔥"), true);
  assert.equal(isAllowedReaction("<script>"), false);
  const map = { "🔥": [ME], "👍": [ME, YOU] };
  assert.deepEqual(sortedReactions(map).map((r) => r.emoji), ["👍", "🔥"]);
  const off = toggleReaction(map, "🔥", ME);
  assert.deepEqual(off, { "👍": [ME, YOU] });
  assert.deepEqual(map["🔥"], [ME]);
  assert.deepEqual(toggleReaction(off, "🎉", YOU), { "👍": [ME, YOU], "🎉": [YOU] });
  assert.deepEqual(sortedReactions({ "👀": [] }), []);
});

test("sidebar ordering", () => {
  const ch = (name: string, position: number) => ({ kind: "channel" as const, name, position, lastMessageAt: null });
  assert.deepEqual(
    [ch("help", 3), ch("general", 1), ch("announcements", 0), ch("acme", 20)].sort(compareChannels).map((c) => c.name),
    ["announcements", "general", "help", "acme"],
  );
  const dm = (name: string, lastMessageAt: string | null) => ({ kind: "dm" as const, name, position: 0, lastMessageAt });
  assert.deepEqual(
    [dm("old", "2026-10-01T00:00:00Z"), dm("never", null), dm("new", "2026-10-14T00:00:00Z")]
      .sort(compareConversations)
      .map((c) => c.name),
    ["new", "old", "never"],
  );
});

test("a closed conversation comes back with a newer message", () => {
  assert.equal(isConversationVisible(null, null), true);
  assert.equal(isConversationVisible("2026-10-10T00:00:00Z", "2026-10-09T00:00:00Z"), false);
  assert.equal(isConversationVisible("2026-10-10T00:00:00Z", "2026-10-11T00:00:00Z"), true);
  assert.equal(isConversationVisible("2026-10-10T00:00:00Z", null), false);
});

test("isUuid", () => {
  assert.equal(isUuid(ME), true);
  assert.equal(isUuid("deleted:x"), false);
  assert.equal(isUuid(undefined), false);
});

test("starting a group: two or more others, within the cap, for vetted people", () => {
  assert.equal(canStartGroup(viewer(), 0).ok, false);
  assert.equal(canStartGroup(viewer(), 1).ok, true);
  assert.equal(canStartGroup(viewer(), 2).ok, true);
  assert.equal(canStartGroup(viewer(), GROUP_MAX_MEMBERS).ok, false);
  assert.equal(canStartGroup(viewer(), GROUP_MAX_MEMBERS - 1).ok, true);
  assert.equal(canStartGroup(viewer({ vetted: false }), 2).ok, false);
  assert.equal(canStartGroup(viewer({ vetted: false }), 1).ok, true);
  assert.equal(canStartGroup(viewer({ vetted: false, staff: true }), 3).ok, true);
});

test("safeguarding: no private conversation puts a student alone with a non-staff adult", () => {
  const student = { id: "s", student: true, staff: false };
  const student2 = { id: "s2", student: true, staff: false };
  const mentor = { id: "m", student: false, staff: false };
  const investor = { id: "i", student: false, staff: false };
  const staff = { id: "a", student: false, staff: true };
  assert.equal(conversationAllowed([student, student2]), true, "students with each other");
  assert.equal(conversationAllowed([mentor, investor]), true, "adults with each other");
  assert.equal(conversationAllowed([student, staff]), true, "anyone with the team");
  assert.equal(conversationAllowed([student, mentor]), false, "student and mentor in a DM");
  assert.equal(conversationAllowed([student, student2, investor]), false, "a group with no staff in it");
  assert.equal(conversationAllowed([student, mentor, staff]), true, "a group the team is in");
});

test("a safeguarded DM or group goes read-only with the reason", () => {
  const dm = channel({ kind: "dm", audience: "members" });
  const me = viewer({ memberOf: ["c1"] });
  const v = canPost(dm, me, { otherPresent: true, safeguarded: true });
  assert.deepEqual(v, { ok: false, reason: SAFEGUARD_REASON });
  // Text channels are never safeguarded: staff can read them.
  assert.equal(canPost(channel(), viewer(), { safeguarded: true }).ok, true);
});

test("the badge counts what the sidebar shows as unread, and nothing else", () => {
  const k = { unread: 4, mentions: 2 };
  assert.equal(attentionFor("channel", k, null, true), 2, "a channel: its mentions");
  assert.equal(attentionFor("channel", k, "all", true), 2);
  assert.equal(attentionFor("channel", k, "none", true), 0, "muted");
  assert.equal(attentionFor("dm", k, null, true), 1, "a conversation: one, however many");
  assert.equal(attentionFor("group", k, "none", true), 0, "muted");
  assert.equal(attentionFor("dm", k, null, false), 0, "closed since its last message");
  assert.equal(attentionFor("dm", { unread: 0, mentions: 0 }, null, true), 0);
});
