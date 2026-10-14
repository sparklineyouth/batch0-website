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
  isAddressedTo,
  nextStatusAction,
  shouldApplyAnswer,
  shouldPruneConnection,
  encodingFor,
  iceRecovery,
  ICE_DISCONNECT_GRACE_MS,
  MAX_ICE_RESTARTS,
  offerDisposition,
  pairTopic,
  overallState,
  readSlots,
  turnServerFrom,
  type SignalMessage,
  type StageMessage,
} from "./live-signal.ts";
import { deriveKey, pairKeyParts } from "./live-keys.ts";

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

// ---------------------------------------------------------------------------
// Addressing — two broadcasters listening on one viewer's inbox
// ---------------------------------------------------------------------------

test("an answer addressed to the other host is not ours", () => {
  // Staff host A and guest speaker B both offer to viewer V, on V's inbox,
  // and both are subscribed there. V's answer to B must not be applied by A.
  const toB = { t: "answer", from: "V", name: "", sdp: "x", to: "B" } satisfies SignalMessage;
  assert.equal(isAddressedTo(toB, "A"), false);
  assert.equal(isAddressedTo(toB, "B"), true);
});

test("candidates and byes are filtered the same way", () => {
  const ice = { t: "ice", from: "V", candidates: [], to: "B" } satisfies SignalMessage;
  const bye = { t: "bye", from: "V", reason: "rebuild", to: "B" } satisfies SignalMessage;
  assert.equal(isAddressedTo(ice, "A"), false);
  assert.equal(isAddressedTo(ice, "B"), true);
  // A viewer rebuilding its link to B must not make A drop a healthy one.
  assert.equal(isAddressedTo(bye, "A"), false);
  assert.equal(isAddressedTo(bye, "B"), true);
});

test("a message with no addressee is accepted — older tabs keep working mid-deploy", () => {
  const legacyAnswer = { t: "answer", from: "V", name: "", sdp: "x" } satisfies SignalMessage;
  const legacyIce = { t: "ice", from: "V", candidates: [] } satisfies SignalMessage;
  const legacyBye = { t: "bye", from: "V", reason: "leave" } satisfies SignalMessage;
  for (const m of [legacyAnswer, legacyIce, legacyBye]) {
    assert.equal(isAddressedTo(m, "A"), true, m.t);
  }
  // An empty string is "no addressee", not "addressed to nobody".
  assert.equal(
    isAddressedTo({ t: "ice", from: "V", candidates: [], to: "" }, "A"),
    true,
  );
  // Variants that never carry `to` are always accepted.
  assert.equal(
    isAddressedTo({ t: "offer", from: "H", name: "Host", sdp: "x" }, "V"),
    true,
  );
  assert.equal(
    isAddressedTo(
      { t: "media", from: "H", slots: { camera: true, screen: false, audio: true } },
      "V",
    ),
    true,
  );
});

test("an answer is applied only while our own offer is outstanding", () => {
  assert.equal(shouldApplyAnswer("have-local-offer"), true);
  // A duplicate or stray answer on a settled connection is dropped quietly —
  // it used to throw "Called in wrong state: stable" into a permanent banner.
  for (const state of ["stable", "have-remote-offer", "closed", "have-local-pranswer"]) {
    assert.equal(shouldApplyAnswer(state), false, state);
  }
});

// ---------------------------------------------------------------------------
// Media state rides on the offer — the late-joiner screen-share fix
// ---------------------------------------------------------------------------

test("an offer can carry the sender's slots, and only real booleans are read", () => {
  const offer: SignalMessage = {
    t: "offer",
    from: "host",
    name: "Ana",
    sdp: "v=0",
    slots: { camera: true, screen: true, audio: false },
  };
  assert.deepEqual(readSlots(offer.t === "offer" ? offer.slots : null), {
    camera: true,
    screen: true,
    audio: false,
  });
  // A tab from before the field sends none: nothing is assumed.
  assert.deepEqual(readSlots(undefined), {});
  assert.deepEqual(readSlots({ camera: "yes", screen: 1, audio: true }), { audio: true });
  assert.deepEqual(readSlots("nope"), {});
});

test("a screen announced on the offer is active before any `media` message", () => {
  const seeded = readSlots({ camera: true, screen: true, audio: true });
  // The muted-at-first receiver track is irrelevant once announced.
  assert.equal(
    slotIsActive({ slot: "screen", announced: seeded.screen, trackLive: false }),
    true,
  );
});

// ---------------------------------------------------------------------------
// Offers: only broadcasters offer
// ---------------------------------------------------------------------------

test("an offer on a viewer's pinned inbox is a forgery and is dropped", () => {
  const offer = (knownRole: "host" | "viewer" | null) =>
    offerDisposition({ kind: "event", pinned: true, selfRole: "host", knownRole });
  assert.equal(offer(null), "drop");
  assert.equal(offer("host"), "drop");
});

test("a host drops an offer from someone it knows as a viewer", () => {
  assert.equal(
    offerDisposition({ kind: "event", pinned: false, selfRole: "host", knownRole: "viewer" }),
    "drop",
  );
});

test("offers from hosts on our own inbox are accepted", () => {
  const offer = (selfRole: "host" | "viewer", knownRole: "host" | null) =>
    offerDisposition({ kind: "event", pinned: false, selfRole, knownRole });
  assert.equal(offer("host", "host"), "accept");
  assert.equal(offer("host", null), "accept");
  // A viewer learns of a host from its first offer.
  assert.equal(offer("viewer", null), "accept");
});

// The 1:1 forgery: every party used to hold every other party's inbox, so a
// student could offer on a staff member's inbox as a made-up "Admin" (drawn on
// staff screens and recorded), or as a real co-host's id, replacing that
// co-host's link under their name.
test("a 1:1 accepts an offer only on its pair line, from someone on the roster", () => {
  const offer = (pinned: boolean, knownRole: "host" | null) =>
    offerDisposition({ kind: "call", pinned, selfRole: "host", knownRole });
  assert.equal(offer(true, "host"), "accept");
  assert.equal(offer(true, null), "drop", "a sender the server never named");
  assert.equal(offer(false, "host"), "drop", "a call has no open inbox");
  assert.equal(offer(false, null), "drop");
});

// ---------------------------------------------------------------------------
// Encoding policy
// ---------------------------------------------------------------------------

test("the screen gets ~1.5 Mbps at 15 fps, kept sharp", () => {
  const e = encodingFor({ slot: "screen", contentHint: "detail", presenting: true, links: 1 })!;
  assert.equal(e.maxBitrate, 1_500_000);
  assert.equal(e.maxFramerate, 15);
  assert.equal(e.scaleResolutionDownBy, 1);
  assert.equal(e.degradationPreference, "maintain-resolution");
});

test("a deck hinted 'text' drops to 5 fps; 'motion' gets 30", () => {
  assert.equal(
    encodingFor({ slot: "screen", contentHint: "text", presenting: true, links: 1 })!.maxFramerate,
    5,
  );
  assert.equal(
    encodingFor({ slot: "screen", contentHint: "motion", presenting: true, links: 1 })!.maxFramerate,
    30,
  );
  assert.equal(
    encodingFor({ slot: "screen", contentHint: "", presenting: true, links: 1 })!.maxFramerate,
    15,
  );
});

test("the camera is ~500 kbps, and a small thumbnail while presenting", () => {
  const cam = encodingFor({ slot: "camera", contentHint: "", presenting: false, links: 1 })!;
  assert.equal(cam.maxBitrate, 500_000);
  assert.equal(cam.scaleResolutionDownBy, 1);
  const thumb = encodingFor({ slot: "camera", contentHint: "", presenting: true, links: 1 })!;
  assert.ok(thumb.maxBitrate <= 150_000);
  assert.equal(thumb.scaleResolutionDownBy, 3);
  assert.equal(thumb.maxFramerate, 15);
});

test("caps shrink as the audience grows, down to a floor", () => {
  const screen = (links: number) =>
    encodingFor({ slot: "screen", contentHint: "detail", presenting: true, links })!.maxBitrate;
  assert.equal(screen(8), 1_500_000);
  assert.equal(screen(20), 600_000);
  assert.equal(screen(500), 300_000);
  assert.ok(screen(20) < screen(10));
  const camera = (links: number) =>
    encodingFor({ slot: "camera", contentHint: "", presenting: false, links })!;
  assert.equal(camera(30).maxBitrate, 200_000);
  assert.equal(camera(30).scaleResolutionDownBy, 2);
  assert.equal(camera(1000).maxBitrate, 150_000);
});

test("audio is never capped", () => {
  assert.equal(encodingFor({ slot: "audio", contentHint: "", presenting: true, links: 50 }), null);
});

// ---------------------------------------------------------------------------
// ICE recovery and the session's overall state
// ---------------------------------------------------------------------------

test("only the offerer restarts ICE, on failure or a long disconnect", () => {
  const r = (o: Partial<Parameters<typeof iceRecovery>[0]>) =>
    iceRecovery({ connectionState: "failed", disconnectedForMs: 0, offerer: true, restarts: 0, ...o });
  assert.equal(r({}), "restart");
  assert.equal(r({ offerer: false }), "wait");
  assert.equal(r({ connectionState: "disconnected", disconnectedForMs: 1_000 }), "wait");
  assert.equal(
    r({ connectionState: "disconnected", disconnectedForMs: ICE_DISCONNECT_GRACE_MS }),
    "restart",
  );
  assert.equal(r({ connectionState: "connected" }), "wait");
  assert.equal(r({ restarts: MAX_ICE_RESTARTS }), "rebuild");
});

test("a webinar host is live whatever one viewer's link is doing", () => {
  assert.equal(overallState({ kind: "event", broadcaster: true, links: ["failed"] }), "live");
  assert.equal(overallState({ kind: "event", broadcaster: true, links: [] }), "live");
});

test("a viewer follows their links to the hosts", () => {
  const v = (links: Parameters<typeof overallState>[0]["links"]) =>
    overallState({ kind: "event", broadcaster: false, links });
  assert.equal(v([]), "connecting");
  assert.equal(v(["failed", "live"]), "live");
  assert.equal(v(["reconnecting", "failed"]), "reconnecting");
  assert.equal(v(["failed", "failed"]), "failed");
});

test("a 1:1 is live only while someone is connected", () => {
  const c = (links: Parameters<typeof overallState>[0]["links"]) =>
    overallState({ kind: "call", broadcaster: true, links });
  assert.equal(c([]), "connecting");
  assert.equal(c(["connecting", "live"]), "live");
  assert.equal(c(["reconnecting"]), "reconnecting");
  assert.equal(c(["failed"]), "connecting");
});

// ---------------------------------------------------------------------------
// TURN config validation
// ---------------------------------------------------------------------------

test("unset TURN is no relay and no problem", () => {
  assert.deepEqual(turnServerFrom({ urls: undefined, username: null, credential: null }), {
    server: null,
    problem: null,
  });
  assert.deepEqual(turnServerFrom({ urls: " , ", username: null, credential: null }), {
    server: null,
    problem: null,
  });
});

test("a valid TURN config passes through", () => {
  const r = turnServerFrom({
    urls: "turn:turn.example.com:3478, turns:turn.example.com:5349?transport=tcp",
    username: "u",
    credential: "c",
  });
  assert.equal(r.problem, null);
  assert.deepEqual(r.server, {
    urls: ["turn:turn.example.com:3478", "turns:turn.example.com:5349?transport=tcp"],
    username: "u",
    credential: "c",
  });
});

test("a bad URL is dropped and named; the good ones survive", () => {
  const r = turnServerFrom({
    urls: "https://turn.example.com,turn:ok.example.com:3478",
    username: "u",
    credential: "c",
  });
  assert.deepEqual(r.server?.urls, ["turn:ok.example.com:3478"]);
  assert.match(r.problem ?? "", /invalid URL/);
});

test("TURN without credentials is refused (the browser would throw)", () => {
  const r = turnServerFrom({ urls: "turn:t.example.com:3478", username: "", credential: null });
  assert.equal(r.server, null);
  assert.match(r.problem ?? "", /USERNAME/);
  // A STUN entry alongside still works.
  const mixed = turnServerFrom({
    urls: "stun:s.example.com:3478,turn:t.example.com:3478",
    username: null,
    credential: null,
  });
  assert.deepEqual(mixed.server, { urls: ["stun:s.example.com:3478"] });
});

// ---------------------------------------------------------------------------
// Channel keys — byte-identical to the derivation every live room already uses
// ---------------------------------------------------------------------------

test("deriveKey matches the keys rooms were minted with (U+0000-joined HMAC)", () => {
  // Reference values computed from the original lib/live-rooms.ts derive(),
  // whose separator was a raw NUL byte in the source. A change here would
  // split every live room between old and new tabs mid-deploy.
  const S = "test-secret-for-live-keys";
  const E = "event:7d8a4c1e-0000-4000-8000-000000000001";
  assert.equal(deriveKey(S, "inbox", E, "user-1"), "Hc8avm01uLCUFqopq4Kf_2");
  assert.equal(deriveKey(S, "lobby", E), "9q7ztKUpsIor13zfNBnfMn");
  assert.equal(deriveKey(S, "room", E), "cEXo-9fdaviVplBPXlN5FE");
  assert.equal(deriveKey(S, "moderation", E), "0XMuYD_HdUpgB-aNkGwVj6");
  assert.equal(deriveKey(S, "stage", E, "host-1"), "3t0n8QJOLNDQAE88v0mmBN");
  assert.equal(
    deriveKey(S, "inbox", "call:7d8a4c1e-0000-4000-8000-000000000002", "user-2"),
    "aZ4AIApBGTcL0jz0k1GQU-",
  );
});

test("a 1:1 pair line: both ends derive the same key, nobody else's pair does", () => {
  const S = "test-secret-for-live-keys";
  const R = "call:7d8a4c1e-0000-4000-8000-000000000002";
  const pair = (a: string, b: string) => deriveKey(S, "pair", ...pairKeyParts(R, a, b));
  assert.equal(pair("student", "staff-a"), pair("staff-a", "student"));
  assert.notEqual(pair("student", "staff-a"), pair("student", "staff-b"));
  assert.notEqual(pair("staff-a", "staff-b"), pair("student", "staff-b"));
  // Never an inbox key, for either end.
  assert.notEqual(pair("student", "staff-a"), deriveKey(S, "inbox", R, "student"));
  assert.notEqual(pair("student", "staff-a"), deriveKey(S, "inbox", R, "staff-a"));
  assert.match(pairTopic(R, "KEY"), /^b0live:call:7d8a4c1e-0000-4000-8000-000000000002:pair:KEY$/);
  assert.notEqual(pairTopic(R, "KEY"), inboxTopic(R, "KEY"));
});

test("deriveKey separates its parts, so shifting a boundary changes the key", () => {
  assert.notEqual(deriveKey("s", "inbox", "ab", "c"), deriveKey("s", "inbox", "a", "bc"));
  assert.equal(deriveKey("s", "inbox", "a").length, 22);
});
