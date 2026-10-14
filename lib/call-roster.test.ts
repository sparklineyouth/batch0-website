import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mergeCallPeers,
  normalizeStaffIds,
  sameStaffList,
  selfIsCallStaff,
  type RosterPeer,
} from "./call-roster.ts";
import { callStaffIds, isCallCounterpart } from "./live.ts";

// Run with `npm test`.
//
// The rules a running 1:1 uses to take in people added after it started
// (addCallCohosts). The first half pins the pure merge; the second walks the
// scenarios the room depends on through the real counterpart rules, with the
// staff list the room now reads (the server's, from the heartbeat) in place of
// the one its page rendered.

const peer = (peerId: string, name = peerId): RosterPeer => ({
  peerId,
  name,
  role: "host",
  inbox: `b0live:call:x:in:${peerId}-key`,
});

// ---------------------------------------------------------------------------
// mergeCallPeers
// ---------------------------------------------------------------------------

test("a plain 1:1 changes nothing: the heartbeat names only who the join did", () => {
  const known = [peer("student")];
  const { peers, added } = mergeCallPeers(known, [peer("student")], "host");
  assert.deepEqual(added, []);
  assert.deepEqual(peers, known);
});

test("someone added mid-call is appended and named in `added`, in the server's order", () => {
  const known = [peer("student"), peer("host")];
  const { peers, added } = mergeCallPeers(
    known,
    [peer("student"), peer("host"), peer("c-cohost"), peer("a-cohost")],
    "b-me",
  );
  assert.deepEqual(
    added.map((p) => p.peerId),
    ["c-cohost", "a-cohost"],
  );
  // Known people keep their places; the new ones follow, as the server sent
  // them — never re-sorted, so the engine's dial order is the server's.
  assert.deepEqual(
    peers.map((p) => p.peerId),
    ["student", "host", "c-cohost", "a-cohost"],
  );
});

test("never self: a browser does not dial its own inbox", () => {
  const { peers, added } = mergeCallPeers(
    [peer("student")],
    [peer("student"), peer("me"), peer("new")],
    "me",
  );
  assert.deepEqual(
    added.map((p) => p.peerId),
    ["new"],
  );
  assert.ok(!peers.some((p) => p.peerId === "me"));
});

test("everyone already known is kept as they were, not replaced by the server's copy", () => {
  const known = [peer("student", "Ana")];
  const { peers } = mergeCallPeers(
    known,
    [{ ...peer("student", "Ana Duarte"), inbox: "somewhere-else" }],
    "host",
  );
  // The object under a possibly mid-negotiation link stays the same one.
  assert.equal(peers[0], known[0]);
  assert.equal(peers[0].name, "Ana");
});

test("someone listed twice in one answer is dialled once", () => {
  const { added } = mergeCallPeers([], [peer("new"), peer("new")], "me");
  assert.deepEqual(
    added.map((p) => p.peerId),
    ["new"],
  );
});

test("a newcomer's inbox is the one the server sent — theirs, not ours", () => {
  const newcomer = { ...peer("new"), inbox: "b0live:call:abc:in:THEIR-KEY" };
  const { added } = mergeCallPeers([], [newcomer], "me");
  assert.equal(added[0].inbox, "b0live:call:abc:in:THEIR-KEY");
});

test("malformed entries are skipped, never dialled", () => {
  const { peers, added } = mergeCallPeers(
    [peer("student")],
    [
      null,
      undefined,
      "new",
      42,
      [],
      {},
      { peerId: "", name: "x", role: "host", inbox: "in" },
      { peerId: 7, name: "x", role: "host", inbox: "in" },
      { peerId: "no-inbox", name: "x", role: "host" },
      { peerId: "empty-inbox", name: "x", role: "host", inbox: "" },
      { peerId: "bad-role", name: "x", role: "admin", inbox: "in" },
      { peerId: "no-role", name: "x", inbox: "in" },
      peer("good"),
    ],
    "me",
  );
  assert.deepEqual(
    added.map((p) => p.peerId),
    ["good"],
  );
  assert.deepEqual(
    peers.map((p) => p.peerId),
    ["student", "good"],
  );
});

test("an answer with no roster in it adds no one", () => {
  const known = [peer("student")];
  for (const incoming of [undefined, null, "peers", 3, {}, { peers: [peer("x")] }]) {
    const { peers, added } = mergeCallPeers(known, incoming, "me");
    assert.deepEqual(added, [], String(incoming));
    assert.deepEqual(peers, known);
  }
});

test("a missing name is blank rather than a reason to leave someone undialled", () => {
  const { added } = mergeCallPeers(
    [],
    [{ peerId: "new", role: "host", inbox: "in" }],
    "me",
  );
  assert.deepEqual(added, [{ peerId: "new", name: "", role: "host", inbox: "in" }]);
});

test("only the four fields are copied; nothing else in the answer rides along", () => {
  const { added } = mergeCallPeers(
    [],
    [{ ...peer("new"), token: "secret", role: "host" }],
    "me",
  );
  assert.deepEqual(Object.keys(added[0]).sort(), ["inbox", "name", "peerId", "role"]);
});

test("neither input is modified, and `peers` is always a fresh array", () => {
  const known = Object.freeze([Object.freeze(peer("student"))]);
  const incoming = Object.freeze([Object.freeze(peer("new"))]);
  const { peers } = mergeCallPeers(known, incoming, "me");
  assert.notEqual(peers, known);
  assert.equal(known.length, 1);
  const unchanged = mergeCallPeers(known, [], "me");
  assert.notEqual(unchanged.peers, known);
  assert.deepEqual(unchanged.peers, known);
});

// ---------------------------------------------------------------------------
// normalizeStaffIds / sameStaffList
// ---------------------------------------------------------------------------

test("a staff list is cleaned in the server's order: host first, no blanks, no repeats", () => {
  assert.deepEqual(
    normalizeStaffIds(["host", "", "c2", 4, null, "c1", "c2", "host"]),
    ["host", "c2", "c1"],
  );
});

test("a staff list with nobody usable on it is ignored, never applied as 'no staff'", () => {
  // Applied, an empty staff side would tell every staff browser it was no
  // longer staff, mid-call.
  for (const raw of [undefined, null, "host", {}, [], ["", null, 3]]) {
    assert.equal(normalizeStaffIds(raw), null, JSON.stringify(raw));
  }
});

test("the same people in another order is not a change", () => {
  assert.equal(sameStaffList(["host", "a", "b"], ["host", "a", "b"]), true);
  assert.equal(sameStaffList(["host", "a", "b"], ["host", "b", "a"]), true);
  assert.equal(sameStaffList(["host", "a"], ["host", "a", "a"]), true);
});

test("a different set of people is a change", () => {
  assert.equal(sameStaffList(["host"], ["host", "new"]), false);
  assert.equal(sameStaffList(["host", "new"], ["host"]), false);
  assert.equal(sameStaffList(["host", "a"], ["host", "b"]), false);
});

test("'not heard yet' equals only itself", () => {
  assert.equal(sameStaffList(null, null), true);
  assert.equal(sameStaffList(null, ["host"]), false);
  assert.equal(sameStaffList(["host"], null), false);
  const list = ["host"];
  assert.equal(sameStaffList(list, list), true);
});

// ---------------------------------------------------------------------------
// selfIsCallStaff
// ---------------------------------------------------------------------------

test("the student's browser is never staff, whatever a heartbeat says", () => {
  const rendered = ["host"];
  assert.equal(selfIsCallStaff({ selfId: "student", rendered, live: null }), false);
  assert.equal(
    selfIsCallStaff({ selfId: "student", rendered, live: ["host", "new"] }),
    false,
  );
  // Even a heartbeat that (wrongly) listed the student cannot promote them.
  assert.equal(
    selfIsCallStaff({ selfId: "student", rendered, live: ["host", "student"] }),
    false,
  );
});

test("staff are staff from the first frame, and stay so while the server agrees", () => {
  const rendered = ["host", "cohost"];
  assert.equal(selfIsCallStaff({ selfId: "cohost", rendered, live: null }), true);
  assert.equal(
    selfIsCallStaff({ selfId: "cohost", rendered, live: ["host", "cohost", "new"] }),
    true,
  );
  assert.equal(selfIsCallStaff({ selfId: "host", rendered, live: ["host"] }), true);
});

test("a server list without this person stands their browser down", () => {
  // Not reachable today — nothing removes anyone from a call, and a person
  // no longer on it is answered 'revoked', with no roster — but the rule is
  // the safe one if that ever changes: their Record control goes.
  assert.equal(
    selfIsCallStaff({ selfId: "cohost", rendered: ["host", "cohost"], live: ["host"] }),
    false,
  );
  assert.equal(selfIsCallStaff({ selfId: "", rendered: [""], live: null }), false);
});

// ---------------------------------------------------------------------------
// Scenarios: the live staff list in the room's own rules
// ---------------------------------------------------------------------------

test("the student is never call staff, before or after someone is added", () => {
  assert.equal(
    selfIsCallStaff({ selfId: "0-student", rendered: ["b-host"], live: ["b-host", "a-admin"] }),
    false,
  );
});

test("for the student, a co-host added mid-call is the other side; for the team, never", () => {
  const rendered = ["host"];
  const live = ["host", "new-cohost"];
  // The student's End call opens once anyone from the team has been with
  // them — the newcomer included, once the list says they are the team.
  assert.equal(isCallCounterpart(rendered, "student", "new-cohost"), false);
  assert.equal(isCallCounterpart(live, "student", "new-cohost"), true);
  // For the host, the newcomer is the team waiting, not the call happening.
  assert.equal(isCallCounterpart(live, "host", "new-cohost"), false);
  assert.equal(isCallCounterpart(live, "host", "student"), true);
});
