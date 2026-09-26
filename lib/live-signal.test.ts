import { test } from "node:test";
import assert from "node:assert/strict";
import {
  connectionTopic,
  inboxTopic,
  lobbyTopic,
  stageTopic,
  slotForMid,
  slotIsActive,
  MEDIA_SLOTS,
  HEARTBEAT_MS,
  PEER_TIMEOUT_MS,
  countLiveAudience,
  nextStatusAction,
  shouldPruneConnection,
  type SignalMessage,
  type StageMessage,
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

// ---------------------------------------------------------------------------
// What a receiver renders
// ---------------------------------------------------------------------------

test("the sender's announcement beats anything the receiver can infer", () => {
  // The case that mattered: a host turns the camera off, the sender detaches
  // the track, the packets stop — and the remote track does NOT reliably go
  // muted, so the transport still reads "live". Believing it leaves the
  // audience on a frozen last frame. The announcement is the only honest
  // account, so it wins in both directions.
  assert.equal(
    slotIsActive({ slot: "camera", announced: false, trackLive: true }),
    false,
  );
  assert.equal(
    slotIsActive({ slot: "camera", announced: true, trackLive: false }),
    true,
  );
  assert.equal(
    slotIsActive({ slot: "screen", announced: true, trackLive: false }),
    true,
  );
});

test("before any announcement, camera and audio fall back to the track", () => {
  // A dropped message must cost a stale label, never the webinar itself.
  assert.equal(
    slotIsActive({ slot: "camera", announced: undefined, trackLive: true }),
    true,
  );
  assert.equal(
    slotIsActive({ slot: "audio", announced: undefined, trackLive: true }),
    true,
  );
  assert.equal(
    slotIsActive({ slot: "camera", announced: undefined, trackLive: false }),
    false,
  );
});

test("an unannounced screen slot is off — nobody presents by default", () => {
  // Every connection carries a screen transceiver from the first offer,
  // before anyone has ever presented. Reading that optimistically is what put
  // viewers in the presenting layout in front of a black rectangle, and a
  // decoded-frames check cannot see it.
  assert.equal(
    slotIsActive({ slot: "screen", announced: undefined, trackLive: true }),
    false,
  );
  assert.equal(
    slotIsActive({ slot: "screen", announced: undefined, trackLive: false }),
    false,
  );
});


// ---------------------------------------------------------------------------
// Pruning and the headcount
// ---------------------------------------------------------------------------

const T0 = 1_000_000;

test("a failed or departed viewer connection is pruned at once", () => {
  for (const state of ["failed", "left"] as const) {
    assert.equal(
      shouldPruneConnection({
        peerRole: "viewer",
        state,
        lastLiveAt: T0,
        createdAt: T0,
        now: T0 + 1,
      }),
      true,
      state,
    );
  }
});

test("a viewer connection not live for longer than PEER_TIMEOUT_MS is pruned", () => {
  const base = { peerRole: "viewer" as const, createdAt: T0 };
  // Was live, then went quiet (a laptop lid closing sends no bye).
  assert.equal(
    shouldPruneConnection({ ...base, state: "reconnecting", lastLiveAt: T0, now: T0 + PEER_TIMEOUT_MS }),
    false,
    "exactly the timeout is still within it",
  );
  assert.equal(
    shouldPruneConnection({ ...base, state: "reconnecting", lastLiveAt: T0, now: T0 + PEER_TIMEOUT_MS + 1 }),
    true,
  );
  // Never came up at all: measured from creation.
  assert.equal(
    shouldPruneConnection({ ...base, state: "connecting", lastLiveAt: null, now: T0 + PEER_TIMEOUT_MS + 1 }),
    true,
  );
  assert.equal(
    shouldPruneConnection({ ...base, state: "connecting", lastLiveAt: null, now: T0 + 5_000 }),
    false,
  );
});

test("a live connection is never pruned, however old", () => {
  assert.equal(
    shouldPruneConnection({
      peerRole: "viewer",
      state: "live",
      lastLiveAt: T0,
      createdAt: T0,
      now: T0 + 10 * PEER_TIMEOUT_MS,
    }),
    false,
  );
});

test("a host-role peer is never pruned — co-hosts and the other party are retried", () => {
  for (const state of ["failed", "left", "reconnecting", "connecting"] as const) {
    assert.equal(
      shouldPruneConnection({
        peerRole: "host",
        state,
        lastLiveAt: null,
        createdAt: T0,
        now: T0 + 10 * PEER_TIMEOUT_MS,
      }),
      false,
      state,
    );
  }
});

test("the headcount counts only live viewer connections", () => {
  assert.equal(
    countLiveAudience([
      { role: "viewer", state: "live" },
      { role: "viewer", state: "live" },
      { role: "viewer", state: "connecting" },
      { role: "viewer", state: "reconnecting" },
      { role: "viewer", state: "failed" },
      { role: "host", state: "live" },
    ]),
    2,
  );
  assert.equal(countLiveAudience([]), 0);
});

// ---------------------------------------------------------------------------
// What a status answer does to a session
// ---------------------------------------------------------------------------

test("'ended' and 'cancelled' close the session immediately", () => {
  assert.equal(nextStatusAction("ended", 0).close, true);
  assert.equal(nextStatusAction("cancelled", 0).close, true);
});

test("'closed' and 'revoked' close only on the second consecutive answer", () => {
  for (const status of ["closed", "revoked"] as const) {
    const first = nextStatusAction(status, 0);
    assert.equal(first.close, false, `${status} once`);
    const second = nextStatusAction(status, first.strikes);
    assert.equal(second.close, true, `${status} twice`);
  }
  // Not consecutive: an 'ok' in between resets the count.
  const a = nextStatusAction("closed", 0);
  const b = nextStatusAction("ok", a.strikes);
  assert.equal(b.strikes, 0);
  assert.equal(nextStatusAction("closed", b.strikes).close, false);
});

test("'error' and a failed request never close anything", () => {
  assert.deepEqual(nextStatusAction("error", 0), { close: false, strikes: 0 });
  assert.deepEqual(nextStatusAction(null, 0), { close: false, strikes: 0 });
  // ...and do not reset a soft-refusal streak either.
  assert.deepEqual(nextStatusAction("error", 1), { close: false, strikes: 1 });
  assert.equal(nextStatusAction("closed", nextStatusAction(null, 1).strikes).close, true);
});

// ---------------------------------------------------------------------------
// Message shapes
// ---------------------------------------------------------------------------

test("the stage carries a content-free room-changed hint, and no host-offline", () => {
  const hint = { t: "room-changed" } satisfies StageMessage;
  assert.deepEqual(hint, { t: "room-changed" });
  // Compile-time: `host-offline` is no longer a StageMessage. If someone adds
  // it back, this @ts-expect-error stops being an error and `npx tsc` fails.
  // @ts-expect-error — removed variant
  const gone: StageMessage = { t: "host-offline", hostId: "h", proof: "p" };
  assert.equal(gone.t, "host-offline");
});

test("a bye may say whether the sender left or is only rebuilding", () => {
  const leave = { t: "bye", from: "a", reason: "leave" } satisfies SignalMessage;
  const rebuild = { t: "bye", from: "a", reason: "rebuild" } satisfies SignalMessage;
  const legacy = { t: "bye", from: "a" } satisfies SignalMessage;
  assert.equal(leave.reason, "leave");
  assert.equal(rebuild.reason, "rebuild");
  assert.equal("reason" in legacy, false);
});
