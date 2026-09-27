import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canReadConversation,
  canSendToConversation,
  cursorColumnFor,
  cursorFor,
  hasUnread,
  isParticipant,
  laterTimestamp,
  orderPair,
  otherParticipant,
  shouldBell,
  unreadCount,
  type DmViewer,
} from "./dm-access.ts";

// Run with `npm test`.
//
// A DM is private: the two people in it, and nobody else — not a classmate,
// not the team, until somebody reports it. These pin that promise in code;
// dm_can_read_conversation() in migration 0089 makes the same promise at the
// row level.

const alice: DmViewer = { userId: "a", moderates: false };
const bob: DmViewer = { userId: "b", moderates: false };
const nosy: DmViewer = { userId: "n", moderates: false };
const mod: DmViewer = { userId: "m", moderates: true };

// Stored ordered, which orderPair() is responsible for.
const convo = { id: "c1", userA: "a", userB: "b" };

test("orderPair sorts so the same two people are always one row", () => {
  assert.deepEqual(orderPair("a", "b"), { userA: "a", userB: "b" });
  assert.deepEqual(orderPair("b", "a"), { userA: "a", userB: "b" });
  // Whoever clicks first, the pair key is identical — this is what the unique
  // index on (user_a, user_b) relies on.
  assert.deepEqual(orderPair("zeta", "alpha"), orderPair("alpha", "zeta"));
});

test("only the two participants can read a DM nobody reported", () => {
  assert.equal(canReadConversation(convo, alice, false), true);
  assert.equal(canReadConversation(convo, bob, false), true);
  assert.equal(canReadConversation(convo, nosy, false), false);
  assert.equal(
    canReadConversation(convo, mod, false),
    false,
    "an unreported DM has no staff read path at all",
  );
});

test("a report is what opens a DM to a moderator, and only to a moderator", () => {
  assert.equal(canReadConversation(convo, mod, true), true);
  assert.equal(
    canReadConversation(convo, nosy, true),
    false,
    "being reported doesn't make a DM public",
  );
});

test("a block freezes sending for both sides, history included", () => {
  assert.equal(canSendToConversation(convo, alice, false), true);
  assert.equal(canSendToConversation(convo, bob, false), true);
  // Symmetric: whoever pressed block, neither can send afterwards.
  assert.equal(canSendToConversation(convo, alice, true), false);
  assert.equal(canSendToConversation(convo, bob, true), false);
  // Reading is unaffected — that's canReadConversation's job, and it doesn't
  // take `blocked` at all.
  assert.equal(canReadConversation(convo, alice, false), true);
});

test("a moderator reading a reported DM still cannot post in it", () => {
  assert.equal(canSendToConversation(convo, mod, false), false);
});

test("participation", () => {
  assert.equal(isParticipant(convo, "a"), true);
  assert.equal(isParticipant(convo, "n"), false);
  assert.equal(otherParticipant(convo, "a"), "b");
  assert.equal(otherParticipant(convo, "b"), "a");
  assert.throws(() => otherParticipant(convo, "n"), /Not your conversation/);
  assert.throws(() => cursorColumnFor(convo, "n"), /Not your conversation/);
});

test("your own messages are never unread to you", () => {
  const messages = [
    { senderId: "a", createdAt: "2026-01-01T00:00:00Z" },
    { senderId: "b", createdAt: "2026-01-02T00:00:00Z" },
    { senderId: "b", createdAt: "2026-01-03T00:00:00Z" },
  ];
  // Alice has read nothing: the two from Bob are unread, hers is not.
  assert.equal(unreadCount(messages, "a", "1970-01-01T00:00:00Z"), 2);
  // Bob has read nothing either, but only Alice's message counts for him —
  // which is why sending doesn't have to move the sender's own cursor.
  assert.equal(unreadCount(messages, "b", "1970-01-01T00:00:00Z"), 1);
  // Caught up.
  assert.equal(unreadCount(messages, "a", "2026-01-03T00:00:00Z"), 0);
});

test("cursors are read off the viewer's own side of the pair", () => {
  const row = {
    ...convo,
    aLastReadAt: "2026-01-05T00:00:00Z",
    bLastReadAt: "1970-01-01T00:00:00Z",
  };
  assert.equal(cursorFor(row, "a"), "2026-01-05T00:00:00Z");
  assert.equal(cursorFor(row, "b"), "1970-01-01T00:00:00Z");
  assert.equal(cursorColumnFor(convo, "a"), "a_last_read_at");
  assert.equal(cursorColumnFor(convo, "b"), "b_last_read_at");
});

test("hasUnread works off the denormalised columns alone", () => {
  const base = {
    ...convo,
    aLastReadAt: "2026-01-01T00:00:00Z",
    bLastReadAt: "2026-01-01T00:00:00Z",
    lastMessageAt: "2026-01-02T00:00:00Z",
    lastSenderId: "b",
  };
  assert.equal(hasUnread(base, "a"), true, "Bob spoke after Alice last looked");
  assert.equal(hasUnread(base, "b"), false, "it was Bob's own message");
  // An empty conversation (opened but never used) is not unread to anyone.
  assert.equal(
    hasUnread({ ...base, lastMessageAt: null, lastSenderId: null }, "a"),
    false,
  );
  // Caught up.
  assert.equal(
    hasUnread({ ...base, aLastReadAt: "2026-01-03T00:00:00Z" }, "a"),
    false,
  );
});

test("a message rings the bell once per burst, and never while the recipient is in the thread", () => {
  const now = Date.parse("2026-09-27T12:00:00Z");
  const base = { id: "c", userA: "a", userB: "b", aLastReadAt: "epoch", bLastReadAt: "epoch" };
  // Never read, nothing unread yet: a new conversation rings.
  assert.equal(shouldBell({ ...base, aLastReadAt: "1970-01-01T00:00:00+00:00", lastMessageAt: null, lastSenderId: null }, "a", now), true);
  // Something already unread for them: that bell is still pointing at it.
  assert.equal(
    shouldBell({ ...base, aLastReadAt: "2026-09-27T10:00:00+00:00", lastMessageAt: "2026-09-27T11:00:00+00:00", lastSenderId: "b" }, "a", now),
    false,
  );
  // Caught up, but read 30s ago — they're in it; the live thread shows it.
  assert.equal(
    shouldBell({ ...base, aLastReadAt: "2026-09-27T11:59:30+00:00", lastMessageAt: "2026-09-27T11:59:20+00:00", lastSenderId: "b" }, "a", now),
    false,
  );
  // Caught up and away for ten minutes: the next message rings.
  assert.equal(
    shouldBell({ ...base, aLastReadAt: "2026-09-27T11:50:00+00:00", lastMessageAt: "2026-09-27T11:49:00+00:00", lastSenderId: "b" }, "a", now),
    true,
  );
});

test("laterTimestamp compares instants, and microseconds when the milliseconds tie", () => {
  assert.equal(laterTimestamp("2026-09-27T12:00:01+00:00", "2026-09-27T12:00:00.999+00:00"), "2026-09-27T12:00:01+00:00");
  assert.equal(laterTimestamp("2026-09-27T12:00:00.123456+00:00", "2026-09-27T12:00:00.123+00:00"), "2026-09-27T12:00:00.123456+00:00");
  assert.equal(laterTimestamp("1970-01-01T00:00:00+00:00", "2026-09-27T12:00:00Z"), "2026-09-27T12:00:00Z");
  assert.equal(laterTimestamp("not a date", "2026-09-27T12:00:00Z"), "2026-09-27T12:00:00Z");
});

