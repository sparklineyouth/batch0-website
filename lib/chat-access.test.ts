import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  asUuid,
  attentionFor,
  badgeText,
  BELL_QUIET_MS,
  bellTitle,
  channelReportsOpenTo,
  defaultReadCursor,
  directoryOffers,
  dmVerdict,
  GROUP_NEEDS_TEAM_REASON,
  pickRefusal,
  withheldHint,
  ONLY_THE_TEAM_REASON,
  reachVerdict,
  FINE_REASON,
  MESSAGE_MAX,
  muteActive,
  MUTED_REASON,
  reportPartyIds,
  reportRouting,
  UNREAD_LOOKBACK_MS,
  canDeleteMessage,
  canEditMessage,
  canManageChannel,
  canMentionEveryone,
  canPin,
  canPost,
  canReadChannel,
  canStartGroup,
  conversationAllowed,
  countsAsMessage,
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
  outsideReportAdvice,
  reportOpenTo,
  reportScope,
  reportVisibleTo,
  shouldBell,
  sidebarMentions,
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
  const dm = { id: "d1", kind: "dm" as const };
  const aboutYou = { partyIds: [YOU] };
  assert.equal(reportVisibleTo(dm, aboutYou, [aboutYou], staff), true);
  assert.equal(reportVisibleTo(dm, aboutYou, [aboutYou], { ...staff, memberOf: ["d1"] }), false, "joined after the report");
  const c1 = { id: "c1", kind: "channel" as const };
  assert.equal(reportVisibleTo(c1, aboutYou, [aboutYou], { ...staff, memberOf: ["c1"] }), true);
  assert.equal(reportVisibleTo(c1, { partyIds: [ME] }, [{ partyIds: [ME] }], staff), false, "sent the reported message");
  // The read rule follows: a party's `reported` is false, so no read path.
  const dmScope = channel({ id: "d1", kind: "dm", audience: "members" });
  assert.equal(canReadChannel(dmScope, staff, channelReportsOpenTo([{ partyIds: [ME, YOU] }], staff)), false);
  assert.equal(canReadChannel(dmScope, staff, channelReportsOpenTo([{ partyIds: [YOU] }], staff)), true);
});

test("a party to any report on a DM or group stays out of every report on it", () => {
  const staff = viewer({ staff: true });
  const first = { partyIds: [ME, YOU] };
  // Reported, then left the group: a later report can't see them as a member
  // any more, but the earlier one still names them.
  const later = { partyIds: [YOU] };
  assert.equal(channelReportsOpenTo([later], staff), true, "on its own the later report would open it");
  assert.equal(channelReportsOpenTo([first, later], staff), false);
  assert.equal(channelReportsOpenTo([later, first], staff), false, "order doesn't matter");
  assert.equal(channelReportsOpenTo([], staff), false, "no report, no read path");
  assert.equal(channelReportsOpenTo([later], viewer()), false, "never for non-staff");
  assert.equal(reportVisibleTo({ id: "g", kind: "group" }, later, [first, later], staff), false);
  assert.deepEqual(reportScope("group", later, [first, later]), [first, later]);
});

test("a text-channel report stands alone, so nobody can bury one with another", () => {
  const MENTOR = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const staff = viewer({ staff: true }); // ME is the only moderator
  const aboutMentor = { partyIds: [MENTOR] };
  // The mentor, reported, files a throwaway report on the moderator's message.
  const throwaway = { partyIds: [ME] };
  const help = { id: "help", kind: "channel" as const };
  assert.equal(reportVisibleTo(help, aboutMentor, [aboutMentor, throwaway], staff), true, "the report about the mentor stays in the queue");
  assert.equal(reportVisibleTo(help, throwaway, [aboutMentor, throwaway], staff), false, "the one about the moderator doesn't reach them");
  assert.deepEqual(reportScope("channel", aboutMentor, [aboutMentor, throwaway]), [aboutMentor]);
  // And the throwaway's parties don't snowball into the next report there.
  assert.deepEqual(
    reportPartyIds({ kind: "channel", members: [], senders: [], messageSenderId: MENTOR, earlier: [throwaway] }),
    [MENTOR],
  );
});

test("a report freezes everyone it could be about", () => {
  const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const MOD = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  // A group: members now, everyone who ever posted (the moderator who said
  // it and left), the reported sender, and earlier reports' parties.
  assert.deepEqual(
    reportPartyIds({ kind: "group", members: [ME, YOU], senders: [ME, MOD, null], messageSenderId: null, earlier: [] }).sort(),
    [ME, YOU, MOD].sort(),
  );
  assert.deepEqual(
    reportPartyIds({ kind: "dm", members: [ME], senders: [], messageSenderId: YOU, earlier: [{ partyIds: [A] }] }).sort(),
    [ME, YOU, A].sort(),
  );
  // A text channel: the message's sender, not the room, not earlier reports.
  assert.deepEqual(
    reportPartyIds({ kind: "channel", members: [ME], senders: [ME, YOU], messageSenderId: MOD, earlier: [] }),
    [MOD],
  );
  assert.deepEqual(
    reportPartyIds({ kind: "channel", members: [], senders: [], messageSenderId: null, earlier: [{ partyIds: [MOD] }] }),
    [],
  );
});

test("report bells go to moderators it leaves out; with nobody left it goes outside", () => {
  const M1 = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const M2 = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const r = (partyIds: string[]) => ({ partyIds });
  // The reported moderator is never told; the other one is.
  assert.deepEqual(reportRouting("dm", [M1, M2], r([ME, M1]), [r([ME, M1])], ME), { notify: [M2], outside: false });
  // Every moderator is a party: nobody on the team can see it.
  assert.deepEqual(reportRouting("dm", [M1], r([ME, M1]), [r([ME, M1])], ME), { notify: [], outside: true });
  assert.deepEqual(reportRouting("group", [], r([ME]), [r([ME])], ME), { notify: [], outside: true });
  // In a conversation an earlier report naming M2 keeps M2 out of the new one too…
  assert.deepEqual(reportRouting("group", [M1, M2], r([ME]), [r([M2]), r([ME])], ME), { notify: [M1], outside: false });
  // …but in a text channel each report stands alone.
  assert.deepEqual(reportRouting("channel", [M1, M2], r([YOU]), [r([M2]), r([YOU])], ME), { notify: [M1, M2], outside: false });
  // A moderator who reports isn't belled about their own report, but can see it.
  assert.deepEqual(reportRouting("dm", [M1], r([YOU]), [r([YOU])], M1), { notify: [], outside: false });
});

test("an outside report tells the reporter where to go now, with the safeguarding contact when there is one", () => {
  const without = outsideReportAdvice(null);
  assert.match(without.join(" "), /none of them is shown your report/);
  assert.match(without.join(" "), /adult you trust/);
  assert.match(without.join(" "), /911/);
  assert.doesNotMatch(without.join(" "), /safeguarding contact/);
  assert.match(outsideReportAdvice("safe@example.org").join(" "), /Email safe@example\.org, batch0's independent safeguarding contact/);
});

test("dmKey is order-independent and refuses a DM with yourself", () => {
  assert.equal(dmKey(ME, YOU), dmKey(YOU, ME));
  assert.equal(dmKey(YOU, ME), `${ME}:${YOU}`);
  assert.throws(() => dmKey(ME, ME));
  assert.equal(otherInDmKey(dmKey(ME, YOU), ME), YOU);
  assert.equal(otherInDmKey(dmKey(ME, YOU), YOU), ME);
  assert.equal(otherInDmKey(dmKey(ME, YOU), "someone"), null);
  assert.equal(otherInDmKey("legacy:abc", ME), null);
  // Case can't make one person two, or two people one row.
  assert.throws(() => dmKey(ME, ME.toUpperCase()));
  assert.equal(dmKey(ME, YOU.toUpperCase()), dmKey(ME, YOU));
  assert.equal(otherInDmKey(dmKey(ME, YOU), ME.toUpperCase()), YOU);
  assert.equal(otherInDmKey(dmKey(ME, YOU).toUpperCase(), ME), YOU);
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
  assert.equal(asUuid(ME.toUpperCase()), ME);
  assert.equal(asUuid("nope"), null);
});

test("one other person is a DM; a group is two or more, within the cap, for vetted people", () => {
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

test("the directory: a DM asks about the pair, a group about everyone in it with the candidate", () => {
  const student = { id: "s", student: true, staff: false };
  const student2 = { id: "s2", student: true, staff: false };
  const mentor = { id: "m", student: false, staff: false };
  const staff = { id: "a", student: false, staff: true };
  // The reviewer's mismatch: pairwise, a student never saw the mentor that a
  // group with staff in it may hold.
  assert.equal(directoryOffers(student, mentor), false, "a DM stays strict");
  assert.equal(directoryOffers(student, mentor, [staff]), true, "a group the team is in");
  assert.equal(directoryOffers(student, mentor, [staff]), conversationAllowed([student, mentor, staff]), "the rule createGroup asks");
  assert.equal(directoryOffers(student, mentor, [student2]), false, "a group with no staff in it");
  assert.equal(directoryOffers(student, mentor, []), false, "nobody else yet: the pair");
  assert.equal(directoryOffers(mentor, student, [staff]), true, "the same from the mentor's side");
  assert.equal(directoryOffers(student, student2, [mentor]), false, "a mentor already in it, no staff");
  assert.equal(directoryOffers(student, staff, [mentor]), true, "staff make any group allowed");
  assert.equal(directoryOffers(null, student), true, "staff searching: anyone");
});

test("New message says why a pick would be refused, in the words the server would use", () => {
  const student = { id: "s", student: true, staff: false };
  const student2 = { id: "s2", student: true, staff: false };
  const mentor = { id: "m", student: false, staff: false };
  const staff = { id: "a", student: false, staff: true };
  assert.equal(pickRefusal(student, []), null, "nothing picked yet");
  assert.equal(pickRefusal(student, [student2]), null);
  assert.equal(pickRefusal(student, [staff, mentor]), null, "a group the team is in");
  // The reviewer's case: staff picked, then a mentor, then staff taken out.
  // One pick is a DM, and the server refuses a DM with the DM's reason.
  assert.equal(pickRefusal(student, [mentor]), SAFEGUARD_REASON);
  assert.equal(pickRefusal(student, [mentor, student2]), GROUP_NEEDS_TEAM_REASON, "two or more are a group");
  assert.equal(pickRefusal(mentor, [student]), SAFEGUARD_REASON, "the same from the mentor's side");
  assert.equal(pickRefusal(null, [mentor]), null, "staff pass");
});

test("the picker's hint names who a team member would let in, from the viewer's side", () => {
  assert.match(withheldHint({ student: true }), /add a mentor, pick someone from the batch0 team first/);
  assert.match(withheldHint({ student: false }), /add a student, pick someone from the batch0 team first/);
  assert.match(withheldHint(null), /someone from the batch0 team/);
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

test("a DM or group on 'Only @mentions' lights the badge and its pill for mentions only", () => {
  const chatter = { unread: 5, mentions: 0 };
  const pinged = { unread: 5, mentions: 2 };
  for (const kind of ["dm", "group"] as const) {
    assert.equal(attentionFor(kind, chatter, "mentions", true), 0, `${kind}: unread, but nobody mentioned you`);
    assert.equal(attentionFor(kind, pinged, "mentions", true), 1, `${kind}: a mention is one, like any unread`);
    assert.equal(attentionFor(kind, pinged, "mentions", false), 0, `${kind}: closed since its last message`);
    assert.equal(attentionFor(kind, chatter, "all", true), 1, `${kind}: "All messages" is the default`);
    assert.equal(attentionFor(kind, chatter, null, true), 1);
    assert.equal(sidebarMentions(kind, chatter, "mentions"), 0, `${kind}: no pill, just bold`);
    assert.equal(sidebarMentions(kind, pinged, "mentions"), 2);
    assert.equal(sidebarMentions(kind, pinged, null), 5, `${kind}: every unread is to you`);
    assert.equal(sidebarMentions(kind, pinged, "all"), 5);
  }
  // A text channel's pill is its mentions, whatever it's set to.
  assert.equal(sidebarMentions("channel", pinged, null), 2);
  assert.equal(sidebarMentions("channel", pinged, "all"), 2);
  // Live, one message's worth: what it adds to the row.
  assert.equal(sidebarMentions("group", { unread: 1, mentions: 0 }, "mentions"), 0);
  assert.equal(sidebarMentions("group", { unread: 1, mentions: 1 }, "mentions"), 1);
  assert.equal(sidebarMentions("dm", { unread: 1, mentions: 0 }, null), 1);
});

test("what counts as a message: chat_counts_as_message in 0101", () => {
  assert.equal(countsAsMessage("message", null), true);
  assert.equal(countsAsMessage("message", "staff"), true);
  assert.equal(countsAsMessage("message", "general"), true);
  assert.equal(countsAsMessage("system", null), false, "a pin or a rename echoes something someone did");
  assert.equal(countsAsMessage("system", "general"), false);
  assert.equal(countsAsMessage("system", "team:x"), false);
  assert.equal(countsAsMessage("system", "staff"), true, "#staff's feed is the news");
  // The SQL, to the letter, so the two can't drift apart unnoticed.
  const sql = readFileSync(new URL("../supabase/migrations/0101_chat.sql", import.meta.url), "utf8");
  const fn = sql.match(/function public\.chat_counts_as_message\(kind text, system_key text\)[\s\S]*?\$\$([\s\S]*?)\$\$/);
  assert.ok(fn, "0101 defines chat_counts_as_message");
  assert.equal(fn[1].trim(), "select kind = 'message' or (kind = 'system' and system_key is not distinct from 'staff');");
});

test("a mute or a fine stops posting, except for staff", () => {
  const now = Date.parse("2026-10-15T12:00:00Z");
  assert.equal(muteActive(null, now), false);
  assert.equal(muteActive({ until: null }, now), true, "until lifted");
  assert.equal(muteActive({ until: "2026-10-15T13:00:00Z" }, now), true);
  assert.equal(muteActive({ until: "2026-10-15T11:00:00Z" }, now), false, "expired");
  assert.deepEqual(canPost(channel(), viewer(), { muted: true }), { ok: false, reason: MUTED_REASON });
  assert.deepEqual(canPost(channel(), viewer(), { fined: true }), { ok: false, reason: FINE_REASON });
  assert.equal(canPost(channel(), viewer({ staff: true }), { muted: true, fined: true }).ok, true);
  const dm = channel({ kind: "dm", audience: "members" });
  const me = viewer({ memberOf: ["c1"] });
  assert.deepEqual(canPost(dm, me, { otherPresent: true, muted: true }), { ok: false, reason: MUTED_REASON });
  // The channel's own state speaks first.
  const ann = canPost(channel({ posting: "staff" }), viewer(), { muted: true });
  assert.ok(!ann.ok && ann.reason !== MUTED_REASON);
});

test("bell titles never carry a group's name or members", () => {
  const t = (kind: "dm" | "group" | "channel", over: Partial<Parameters<typeof bellTitle>[1]> = {}) =>
    bellTitle(kind, { sender: "Ann", channelName: "help", mentioned: false, everyone: false, ...over });
  assert.equal(t("dm"), "Ann messaged you");
  assert.equal(t("group", { channelName: "secret plans" }), "Ann in a group chat");
  assert.equal(t("channel"), "Ann posted in #help");
  assert.equal(t("channel", { mentioned: true }), "Ann mentioned you in #help");
  assert.equal(t("channel", { mentioned: true, everyone: true }), "Ann pinged everyone in #help");
});

test("a channel never opened counts as unread from two weeks back, a conversation from the start", () => {
  const now = Date.parse("2026-10-15T12:00:00Z");
  assert.equal(defaultReadCursor("channel", now), new Date(now - UNREAD_LOOKBACK_MS).toISOString());
  assert.equal(defaultReadCursor("dm", now), new Date(0).toISOString());
  assert.equal(defaultReadCursor("group", now), new Date(0).toISOString());
});

test("who can open a DM: reachable first, then the safeguarding rule", () => {
  const student = { id: "s", student: true, staff: false };
  const mentor = { id: "m", student: false, staff: false };
  const staff = { id: "a", student: false, staff: true };
  const as = (party: typeof student, over: { vetted?: boolean } = {}) => ({ staff: party.staff, vetted: over.vetted ?? true, party });
  // A fresh signup learns nothing about a mentor — not even that safeguarding applies.
  assert.deepEqual(dmVerdict(as(student, { vetted: false }), { ...mentor, vetted: true }), { ok: false, reason: ONLY_THE_TEAM_REASON });
  // An accepted student is told why they can't DM a mentor.
  assert.deepEqual(dmVerdict(as(student), { ...mentor, vetted: true }), { ok: false, reason: SAFEGUARD_REASON });
  assert.equal(dmVerdict(as(student), { ...student, id: "s2", vetted: true }).ok, true);
  assert.equal(dmVerdict(as(student, { vetted: false }), { ...staff, vetted: false }).ok, true, "anyone can write to the team");
  assert.equal(dmVerdict(as(staff), { ...student, vetted: false }).ok, true, "the team can write to anyone");
  assert.equal(dmVerdict(as(student), { ...student, id: "s2", vetted: false }).ok, false, "not let in yet");
  // A group checks reach per person and safeguarding once, on everyone: a
  // mentor is reachable for a student, so a group with staff in it can form.
  assert.equal(reachVerdict({ staff: false, vetted: true }, { staff: false, vetted: true }).ok, true);
  assert.equal(conversationAllowed([student, mentor, staff]), true);
  assert.equal(reachVerdict({ staff: false, vetted: false }, { staff: false, vetted: true }).ok, false);
});
