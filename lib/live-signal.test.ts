import { test } from "node:test";
import assert from "node:assert/strict";
import {
  connectionTopic,
  inboxTopic,
  lobbyTopic,
  stageTopic,
  slotForMid,
  MEDIA_SLOTS,
  HEARTBEAT_MS,
  PEER_TIMEOUT_MS,
} from "./live-signal.ts";

/**
 * The batch0 Live protocol rules that are load-bearing for privacy.
 *
 * These are pure functions precisely so they can be pinned here: the audience
 * guarantee should not rest on a rule that only exists as a comment in a
 * 500-line React hook. If `connectionTopic` ever starts returning a host's
 * topic to a viewer, that is the whole webinar privacy model gone, and it
 * should fail here rather than in front of a cohort.
 */

// ---------------------------------------------------------------------------
// connectionTopic — the rule that keeps the audience hidden
// ---------------------------------------------------------------------------

const HOST = { role: "host" as const, inbox: "b0live:e1:in:HOSTKEY" };
const VIEWER_A = { role: "viewer" as const, inbox: "b0live:e1:in:AAAA" };
const VIEWER_B = { role: "viewer" as const, inbox: "b0live:e1:in:BBBB" };

test("a viewer negotiates on its OWN inbox, never the host's", () => {
  const topic = connectionTopic({
    selfRole: "viewer",
    selfInbox: VIEWER_A.inbox,
    peerRole: "host",
    peerInbox: HOST.inbox,
  });
  assert.equal(topic, VIEWER_A.inbox);
  // The point of the whole rule: a viewer must never end up publishing to,
  // and therefore needing to know, the host's topic — any viewer holding it
  // could subscribe and watch every other viewer's answer go by.
  assert.notEqual(topic, HOST.inbox);
});

test("a host talking to a viewer uses that viewer's inbox", () => {
  const topic = connectionTopic({
    selfRole: "host",
    selfInbox: HOST.inbox,
    peerRole: "viewer",
    peerInbox: VIEWER_A.inbox,
  });
  assert.equal(topic, VIEWER_A.inbox);
});

test("both ends of a host/viewer pair agree on one topic", () => {
  const fromViewer = connectionTopic({
    selfRole: "viewer",
    selfInbox: VIEWER_A.inbox,
    peerRole: "host",
    peerInbox: HOST.inbox,
  });
  const fromHost = connectionTopic({
    selfRole: "host",
    selfInbox: HOST.inbox,
    peerRole: "viewer",
    peerInbox: VIEWER_A.inbox,
  });
  // If these ever disagree the offer and the answer go to different channels,
  // and the call silently never connects.
  assert.equal(fromViewer, fromHost);
});

test("two viewers never share a channel", () => {
  const a = connectionTopic({
    selfRole: "host",
    selfInbox: HOST.inbox,
    peerRole: "viewer",
    peerInbox: VIEWER_A.inbox,
  });
  const b = connectionTopic({
    selfRole: "host",
    selfInbox: HOST.inbox,
    peerRole: "viewer",
    peerInbox: VIEWER_B.inbox,
  });
  assert.notEqual(a, b);
});

test("two hosts address each other directly (a 1:1 has no audience)", () => {
  const other = { role: "host" as const, inbox: "b0live:e1:in:OTHER" };
  assert.equal(
    connectionTopic({
      selfRole: "host",
      selfInbox: HOST.inbox,
      peerRole: "host",
      peerInbox: other.inbox,
    }),
    other.inbox,
  );
  assert.equal(
    connectionTopic({
      selfRole: "host",
      selfInbox: other.inbox,
      peerRole: "host",
      peerInbox: HOST.inbox,
    }),
    HOST.inbox,
  );
});

// ---------------------------------------------------------------------------
// Topic namespacing
// ---------------------------------------------------------------------------

test("topics are namespaced so rooms and kinds can't collide", () => {
  assert.match(stageTopic("event:abc"), /^b0live:event:abc:stage$/);
  assert.match(inboxTopic("event:abc", "KEY"), /^b0live:event:abc:in:KEY$/);
  assert.match(lobbyTopic("event:abc", "KEY"), /^b0live:event:abc:lobby:KEY$/);

  // A webinar and a 1:1 that somehow shared a uuid must not share a channel.
  assert.notEqual(stageTopic("event:abc"), stageTopic("call:abc"));
});

test("the lobby topic is unguessable without the key", () => {
  assert.notEqual(lobbyTopic("event:abc", "K1"), lobbyTopic("event:abc", "K2"));
});

// ---------------------------------------------------------------------------
// Media slots — the no-renegotiation scheme
// ---------------------------------------------------------------------------

test("slots map to mids by fixed creation order", () => {
  assert.equal(slotForMid("0"), "camera");
  assert.equal(slotForMid("1"), "screen");
  assert.equal(slotForMid("2"), "audio");
  assert.deepEqual([...MEDIA_SLOTS], ["camera", "screen", "audio"]);
});

test("an unknown or absent mid maps to nothing rather than guessing", () => {
  // Guessing here would attach a remote track to the wrong slot, which shows
  // up as the host's camera appearing where their slides should be.
  assert.equal(slotForMid(null), null);
  assert.equal(slotForMid("3"), null);
  assert.equal(slotForMid("-1"), null);
  assert.equal(slotForMid(""), null);
  assert.equal(slotForMid("abc"), null);
  assert.equal(slotForMid("1.5"), null);
});

// ---------------------------------------------------------------------------
// Timings
// ---------------------------------------------------------------------------

test("a peer times out only after several missed heartbeats", () => {
  // A single dropped heartbeat must not evict a student who is fine. Three
  // beats of headroom is what makes the timeout mean "gone" rather than
  // "unlucky".
  assert.ok(
    PEER_TIMEOUT_MS >= HEARTBEAT_MS * 3,
    `PEER_TIMEOUT_MS (${PEER_TIMEOUT_MS}) should allow at least 3 missed heartbeats (${HEARTBEAT_MS})`,
  );
});
