import { test } from "node:test";
import assert from "node:assert/strict";
import {
  audienceCanSeeEachOther,
  canBroadcast,
  canEndForEveryone,
  chatMessageIsLive,
  formatBytes,
  isDeckFile,
  isHostedOnBatch0,
  isPremiere,
  isReaction,
  messagesNeedApproval,
  normalizeAudienceMode,
  normalizeChatMessage,
  normalizePoll,
  pollPercentages,
  premiereState,
  recordingSegmentSlot,
  electRecorder,
  parseSegmentRun,
  presentForRecording,
  recordingRival,
  recordingSegmentStart,
  webinarSegmentName,
  AUDIENCE_MODES,
  RECORDER_LEASE_MS,
  RECORDER_RECONNECT_GRACE_MS,
  RECORDING_AUDIO_BITRATE,
  RECORDING_SEGMENT_SECONDS,
  RECORDING_VIDEO_BITRATE,
  MAX_CHAT_LENGTH,
  MAX_POLL_OPTIONS,
  type AudienceMode,
} from "./webinars.ts";
import { can, capabilitiesFrom } from "./permissions.ts";

// Run with `npm test`. No framework, no transpile step — Node strips the types
// natively, which is why lib/webinars.ts is kept import-free.

// ---------------------------------------------------------------------------
// Audience mode
// ---------------------------------------------------------------------------
//
// These three functions are the entire privacy switch for chat, upvotes and
// reactions. They are one boolean each, which makes them exactly the kind of
// rule that gets inverted by a refactor and noticed by a cohort. So they are
// tested exhaustively by mode rather than by example, and the case that
// matters most — that an unknown value fails CLOSED — is tested hardest.

test("only moderated and open let the audience see itself", () => {
  assert.equal(audienceCanSeeEachOther("private"), false);
  assert.equal(audienceCanSeeEachOther("moderated"), true);
  assert.equal(audienceCanSeeEachOther("open"), true);
});

test("no mode outside the declared list grants audience visibility", () => {
  // Exhaustive over the union, so adding a fourth mode without deciding what
  // it discloses fails here rather than in a room.
  const visible = AUDIENCE_MODES.filter(audienceCanSeeEachOther);
  assert.deepEqual(
    visible,
    ["moderated", "open"],
    "A new audience mode must have its disclosure decided explicitly",
  );
});

test("only moderated holds messages for approval", () => {
  assert.equal(messagesNeedApproval("private"), false);
  assert.equal(messagesNeedApproval("moderated"), true);
  assert.equal(
    messagesNeedApproval("open"),
    false,
    "Open chat is un-gated by definition — approving there would be a queue nobody empties",
  );
});

test("an unrecognised audience mode becomes private, never open", () => {
  // The rows that matter here are real: every event written before migration
  // 0084 has NULL in this column. A deploy that is ahead of the database must
  // show a webinar with no chat, not one with unmoderated chat.
  for (const bad of [null, undefined, "", "public", "OPEN", 0, {}, []]) {
    assert.equal(
      normalizeAudienceMode(bad),
      "private",
      `${JSON.stringify(bad)} must fail closed`,
    );
  }
  assert.equal(normalizeAudienceMode("moderated"), "moderated");
  assert.equal(normalizeAudienceMode("open"), "open");
});

test("a pending message is never live, and nothing is live in a private room", () => {
  const approved = { approvedAt: "2026-09-21T18:00:00Z" };
  const pending = { approvedAt: null };
  assert.equal(chatMessageIsLive(approved, "open"), true);
  assert.equal(chatMessageIsLive(pending, "open"), false);
  assert.equal(chatMessageIsLive(approved, "moderated"), true);
  assert.equal(chatMessageIsLive(pending, "moderated"), false);
  assert.equal(
    chatMessageIsLive(approved, "private"),
    false,
    "An approved message in a private room is still not shown — the room has no chat",
  );
});

// ---------------------------------------------------------------------------
// Who may broadcast
// ---------------------------------------------------------------------------

test("events.manage broadcasts, with or without a speaker row", () => {
  assert.equal(
    canBroadcast({ hasEventsManage: true, userId: "staff", speakers: [] }),
    true,
  );
});

test("a speaker row broadcasts without any global permission", () => {
  assert.equal(
    canBroadcast({
      hasEventsManage: false,
      userId: "guest",
      speakers: [{ userId: "guest" }],
    }),
    true,
    "This is the whole point of the table — a guest needs a camera, not the admin panel",
  );
});

test("a student is not a speaker, and an unclaimed speaker row grants nobody a camera", () => {
  assert.equal(
    canBroadcast({
      hasEventsManage: false,
      userId: "student",
      speakers: [{ userId: "guest" }],
    }),
    false,
  );
  assert.equal(
    canBroadcast({
      hasEventsManage: false,
      userId: "student",
      // A card an admin typed in, not yet claimed by anyone.
      speakers: [{ userId: null }],
    }),
    false,
    "A null user_id must never match a null-ish caller",
  );
});

test("a signed-out caller never broadcasts, even against an unclaimed row", () => {
  assert.equal(
    canBroadcast({
      hasEventsManage: false,
      userId: null,
      speakers: [{ userId: null }],
    }),
    false,
  );
});

test("an admin is always a host: events.manage arrives through the '*' wildcard", () => {
  // "Admin is always host" rests on this chain: the admin role holds '*', `can`
  // turns that into events.manage, and canBroadcast needs nothing else — no
  // speaker row, no visibility, no join window.
  const admin = capabilitiesFrom("admin", ["*"]);
  assert.equal(
    canBroadcast({
      hasEventsManage: can(admin, "events.manage"),
      userId: "admin",
      speakers: [],
    }),
    true,
  );
  // So does any custom role an admin ticks Manage events on (the seeded intern).
  const intern = capabilitiesFrom("intern", ["events.manage"]);
  assert.equal(
    canBroadcast({
      hasEventsManage: can(intern, "events.manage"),
      userId: "intern",
      speakers: [],
    }),
    true,
  );
  // A mentor is not a host by role — only through a claimed speaker row.
  const mentor = capabilitiesFrom("mentor", ["mentor.panel"]);
  assert.equal(
    canBroadcast({
      hasEventsManage: can(mentor, "events.manage"),
      userId: "mentor",
      speakers: [],
    }),
    false,
  );
});

// ---------------------------------------------------------------------------
// Ending for everyone
// ---------------------------------------------------------------------------

test("staff may always end a webinar for everyone", () => {
  assert.equal(canEndForEveryone({ isStaff: true, isSpeaker: false, staffPresent: true }), true);
  assert.equal(canEndForEveryone({ isStaff: true, isSpeaker: false, staffPresent: false }), true);
});

test("a guest speaker may end only when no staff host is in the room", () => {
  // The founder who presses End thinking it ends their segment, while the
  // admin is still presenting, must be refused.
  assert.equal(canEndForEveryone({ isStaff: false, isSpeaker: true, staffPresent: true }), false);
  // A guest-only webinar must still be closable by its last speaker.
  assert.equal(canEndForEveryone({ isStaff: false, isSpeaker: true, staffPresent: false }), true);
});

test("a viewer never ends anything", () => {
  assert.equal(canEndForEveryone({ isStaff: false, isSpeaker: false, staffPresent: false }), false);
});

// ---------------------------------------------------------------------------
// Premieres — the clock
// ---------------------------------------------------------------------------
//
// The offset these produce is what every viewer's player seeks to, so an error
// here is not a wrong number on a screen: it is the whole audience watching a
// different moment from each other, or a Q&A that never opens.

const START = new Date("2026-09-21T18:00:00Z");
const SECONDS = 40 * 60; // a 40-minute recording
const MINUTE = 60_000;

/** `minutes` relative to the premiere's start. */
function at(minutes: number): Date {
  return new Date(START.getTime() + minutes * MINUTE);
}

test("before the start, a premiere is waiting and counts down", () => {
  const s = premiereState({
    startsAt: START,
    premiereSeconds: SECONDS,
    now: at(-5),
  });
  assert.equal(s.phase, "waiting");
  assert.equal(s.secondsUntilNext, 300);
});

test("a viewer arriving twenty minutes late is seeked twenty minutes in", () => {
  // This single assertion is the feature. Without it a late arrival watches
  // from the top, which is the difference between a premiere and a video.
  const s = premiereState({
    startsAt: START,
    premiereSeconds: SECONDS,
    now: at(20),
  });
  assert.equal(s.phase, "playing");
  assert.equal(s.offsetSeconds, 20 * 60);
});

test("when the recording runs out, the room goes live", () => {
  const s = premiereState({
    startsAt: START,
    premiereSeconds: SECONDS,
    now: at(41),
  });
  assert.equal(s.phase, "live");
});

test("a host going live early beats the schedule immediately", () => {
  // The alternative is an audience watching a recording of somebody who is, at
  // that moment, live on the other side of the same page.
  const s = premiereState({
    startsAt: START,
    premiereSeconds: SECONDS,
    liveStartedAt: at(12),
    now: at(15),
  });
  assert.equal(s.phase, "live");
  assert.equal(s.offsetSeconds, 0);
});

test("a live_started_at in the future does not yet end the premiere", () => {
  // Guards against a clock skew or a scheduled stamp switching the room over
  // before the host is actually there.
  const s = premiereState({
    startsAt: START,
    premiereSeconds: SECONDS,
    liveStartedAt: at(30),
    now: at(10),
  });
  assert.equal(s.phase, "playing");
  assert.equal(s.offsetSeconds, 10 * 60);
});

test("an explicit qaOpensAt moves the handover without moving the video", () => {
  // A 40-minute talk with Q&A at the top of the hour: the recording still ends
  // at 40 minutes, and the last 20 hold on the final frame rather than seeking
  // past the end, where browsers disagree about what happens.
  const held = premiereState({
    startsAt: START,
    premiereSeconds: SECONDS,
    qaOpensAt: at(60),
    now: at(50),
  });
  assert.equal(held.phase, "playing");
  assert.equal(
    held.offsetSeconds,
    SECONDS,
    "Clamped to the recording's length — never seek past the end",
  );

  const after = premiereState({
    startsAt: START,
    premiereSeconds: SECONDS,
    qaOpensAt: at(60),
    now: at(61),
  });
  assert.equal(after.phase, "live");
});

test("an event with no premiere video is live from its start time", () => {
  const s = premiereState({
    startsAt: START,
    premiereSeconds: null,
    now: at(1),
  });
  assert.equal(s.phase, "live");
});

test("a hosted webinar opened early is live, not a premiere 'waiting'", () => {
  // Regression: an admin setting up ten minutes early had their camera
  // controls and End button hidden, and the camera switched itself on at the
  // scheduled start. With nothing to play there is nothing to wait for.
  const s = premiereState({
    startsAt: START,
    premiereSeconds: null,
    now: at(-10),
  });
  assert.equal(s.phase, "live");
  assert.equal(s.secondsUntilNext, null);
});

test("End for everyone ends a premiere mid-recording", () => {
  const s = premiereState({
    startsAt: START,
    premiereSeconds: SECONDS,
    liveEndedAt: at(15),
    now: at(20),
  });
  assert.equal(s.phase, "ended");
});

test("End beats a host having gone live, and a hosted webinar, too", () => {
  assert.equal(
    premiereState({
      startsAt: START,
      premiereSeconds: SECONDS,
      liveStartedAt: at(10),
      liveEndedAt: at(30),
      now: at(31),
    }).phase,
    "ended",
  );
  assert.equal(
    premiereState({
      startsAt: START,
      premiereSeconds: null,
      liveEndedAt: at(30),
      now: at(31),
    }).phase,
    "ended",
  );
});

test("liveStartedAt still wins over the schedule when nobody has ended it", () => {
  const s = premiereState({
    startsAt: START,
    premiereSeconds: SECONDS,
    liveStartedAt: at(-5),
    liveEndedAt: null,
    now: at(-2),
  });
  assert.equal(s.phase, "live");
});

test("long past the end, a premiere is over", () => {
  const s = premiereState({
    startsAt: START,
    premiereSeconds: SECONDS,
    endsAt: at(60),
    now: at(95),
  });
  assert.equal(s.phase, "ended");
});

test("the offset never goes negative at the exact start instant", () => {
  const s = premiereState({
    startsAt: START,
    premiereSeconds: SECONDS,
    now: START,
  });
  assert.equal(s.phase, "playing");
  assert.equal(s.offsetSeconds, 0);
});

// ---------------------------------------------------------------------------
// live_mode helpers
// ---------------------------------------------------------------------------

test("both batch0-hosted modes are recognised as ours", () => {
  assert.equal(isHostedOnBatch0("hosted"), true);
  assert.equal(isHostedOnBatch0("premiere"), true);
  assert.equal(isHostedOnBatch0("external"), false);
  assert.equal(isHostedOnBatch0(null), false);
  assert.equal(isHostedOnBatch0(undefined), false);
});

test("only a premiere is a premiere", () => {
  assert.equal(isPremiere("premiere"), true);
  assert.equal(isPremiere("hosted"), false);
});

// ---------------------------------------------------------------------------
// Chat normalisation
// ---------------------------------------------------------------------------

test("a chat message keeps its line breaks but not a wall of them", () => {
  assert.equal(
    normalizeChatMessage("one\n\n\n\n\ntwo"),
    "one\n\ntwo",
    "Chat is speech — a two-line answer is normal, a screenful of blanks is not",
  );
});

test("a chat message collapses runs of spaces without eating newlines", () => {
  assert.equal(normalizeChatMessage("a    b\nc  \t d"), "a b\nc d");
});

test("empty and whitespace-only messages are refused", () => {
  assert.equal(normalizeChatMessage(""), null);
  assert.equal(normalizeChatMessage("   \n\n  \t "), null);
});

test("a chat message is capped at the length the database accepts", () => {
  const long = "x".repeat(MAX_CHAT_LENGTH + 500);
  assert.equal(normalizeChatMessage(long)?.length, MAX_CHAT_LENGTH);
});

// ---------------------------------------------------------------------------
// Polls
// ---------------------------------------------------------------------------

test("a poll needs a question and at least two distinct options", () => {
  assert.equal(
    normalizePoll({ question: "  ", options: ["a", "b"] }).ok,
    false,
  );
  assert.equal(normalizePoll({ question: "Ready?", options: ["a"] }).ok, false);
  const dup = normalizePoll({ question: "Ready?", options: ["Yes", " yes "] });
  assert.equal(
    dup.ok,
    false,
    "Two identical options split the vote and the voter cannot tell which they picked",
  );
});

test("a poll refuses more options than the schema allows", () => {
  const many = Array.from({ length: MAX_POLL_OPTIONS + 1 }, (_, i) => `opt${i}`);
  assert.equal(normalizePoll({ question: "Pick", options: many }).ok, false);
});

test("a valid poll comes back trimmed, with blanks dropped", () => {
  const r = normalizePoll({
    question: "  Which   one?  ",
    options: ["  Yes ", "", "  No  ", "   "],
  });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.question, "Which one?");
    assert.deepEqual(r.options, ["Yes", "No"]);
  }
});

test("poll percentages always add to 100", () => {
  // Naive rounding of thirds shows 33/33/33 under a bar that visibly fills the
  // row, and a poll whose numbers don't add up is the kind of small wrongness
  // an audience notices immediately.
  assert.deepEqual(pollPercentages([1, 1, 1]), [34, 33, 33]);
  assert.equal(
    pollPercentages([1, 1, 1]).reduce((a, b) => a + b, 0),
    100,
  );
  assert.deepEqual(pollPercentages([0, 0]), [0, 0], "No votes is 0%, not NaN");
  assert.deepEqual(pollPercentages([3, 1]), [75, 25]);
});

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

test("a deck is recognised by extension even when the browser sends no type", () => {
  // Browsers disagree about pptx: Chrome sends the long OpenXML type, some
  // Windows setups send application/octet-stream, and a file dragged out of a
  // zip can arrive with an empty type. Rejecting on MIME alone turns "upload
  // your deck" into a coin flip.
  assert.equal(isDeckFile("Fundraising.pptx", ""), true);
  assert.equal(isDeckFile("Fundraising.pptx", "application/octet-stream"), true);
  assert.equal(isDeckFile("notes.PDF", null), true);
  assert.equal(isDeckFile("talk.key", null), false);
  assert.equal(isDeckFile("recording.webm", "video/webm"), false);
});

test("a deck is recognised by MIME type even with an odd filename", () => {
  assert.equal(isDeckFile("download", "application/pdf"), true);
});

test("byte sizes render coarsely and never as NaN", () => {
  assert.equal(formatBytes(null), "");
  assert.equal(formatBytes(undefined), "");
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatBytes(45 * 1024 * 1024), "45 MB");
});

// ---------------------------------------------------------------------------
// Reactions
// ---------------------------------------------------------------------------

test("only the fixed reaction alphabet is accepted", () => {
  // Reactions are never stored and never moderated, so this list IS the
  // moderation: the only thing keeping a room of teenagers from putting
  // something unpleasant on everyone's screen is that the alphabet is this
  // array.
  assert.equal(isReaction("👏"), true);
  assert.equal(isReaction("🖕"), false);
  assert.equal(isReaction("<img onerror=alert(1)>"), false);
  assert.equal(isReaction(""), false);
  assert.equal(isReaction(null), false);
  assert.equal(isReaction(42), false);
});

// ---------------------------------------------------------------------------
// Recording segments
// ---------------------------------------------------------------------------

test("a re-registered segment keeps its slot, so nothing plays twice", () => {
  const taken = [
    { sortOrder: 0, storagePath: "e/recording/segment-0000-1.webm" },
    { sortOrder: 1, storagePath: "e/recording/segment-0001-2.webm" },
  ];
  assert.deepEqual(
    recordingSegmentSlot(1, "e/recording/segment-0001-2.webm", taken),
    { kind: "existing", sortOrder: 1 },
  );
});

test("a free index is taken as asked", () => {
  assert.deepEqual(recordingSegmentSlot(0, "e/recording/a.webm", []), {
    kind: "insert",
    sortOrder: 0,
  });
  assert.deepEqual(
    recordingSegmentSlot(2, "e/recording/c.webm", [
      { sortOrder: 0, storagePath: "e/recording/a.webm" },
      { sortOrder: 1, storagePath: "e/recording/b.webm" },
    ]),
    { kind: "insert", sortOrder: 2 },
  );
});

test("a reloaded recorder's segment 0 is appended, never written over the first run", () => {
  // The host reloaded after three segments; the new run numbers from zero.
  const taken = [0, 1, 2].map((i) => ({
    sortOrder: i,
    storagePath: `e/recording/segment-000${i}-100${i}.webm`,
  }));
  assert.deepEqual(
    recordingSegmentSlot(0, "e/recording/segment-0000-2000.webm", taken),
    { kind: "insert", sortOrder: 3 },
  );
  assert.deepEqual(
    recordingSegmentSlot(1, "e/recording/segment-0001-2001.webm", [
      ...taken,
      { sortOrder: 3, storagePath: "e/recording/segment-0000-2000.webm" },
    ]),
    { kind: "insert", sortOrder: 4 },
  );
});

test("a nonsense index falls back to zero rather than a NaN sort order", () => {
  assert.deepEqual(recordingSegmentSlot(Number.NaN, "e/r/a.webm", []), {
    kind: "insert",
    sortOrder: 0,
  });
  assert.deepEqual(recordingSegmentSlot(-3, "e/r/a.webm", []), {
    kind: "insert",
    sortOrder: 0,
  });
});

// Stored paths as the live room now writes them: the server appends its own
// upload stamp to `segment-<run>-<index>.webm`.
function runPath(run: number, index: number, stamp = run + index): string {
  return `e/recording/${webinarSegmentName(run, index).replace(".webm", "")}-${stamp}.webm`;
}

test("a segment path carries its run and index; a pre-run path carries neither", () => {
  assert.equal(webinarSegmentName(1790000000000, 3), "segment-1790000000000-0003.webm");
  assert.deepEqual(parseSegmentRun(runPath(1790000000000, 3)), {
    run: 1790000000000,
    index: 3,
  });
  assert.equal(parseSegmentRun("e/recording/segment-0003-1790000000000.webm"), null);
  assert.equal(parseSegmentRun("e/recording/a.webm"), null);
});

test("a reload's segments never fill the gaps an earlier run left", () => {
  // The reviewer's case: run 1 registers 0 and 1, segment 2's upload fails
  // (the recorder never retries), segment 3 registers. The host reloads and
  // run 2 numbers from zero again.
  const RUN1 = 1000;
  const RUN2 = 2000;
  const taken = [
    { sortOrder: 0, storagePath: runPath(RUN1, 0) },
    { sortOrder: 1, storagePath: runPath(RUN1, 1) },
    { sortOrder: 3, storagePath: runPath(RUN1, 3) },
  ];
  const register = (run: number, index: number) => {
    const slot = recordingSegmentSlot(index, runPath(run, index), taken);
    assert.equal(slot.kind, "insert");
    taken.push({ sortOrder: slot.sortOrder, storagePath: runPath(run, index) });
    return slot.sortOrder;
  };
  const s0 = register(RUN2, 0);
  const s1 = register(RUN2, 1);
  const s2 = register(RUN2, 2);
  assert.ok(s0 > 3, "run 2 starts after everything run 1 registered");
  assert.ok(s1 > s0 && s2 > s1, "run 2 plays in its own order");
  assert.notEqual(s2, 2, "run 2's segment 2 must not land in run 1's gap");

  const order = [...taken]
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((t) => parseSegmentRun(t.storagePath));
  assert.deepEqual(order, [
    { run: RUN1, index: 0 },
    { run: RUN1, index: 1 },
    { run: RUN1, index: 3 },
    { run: RUN2, index: 0 },
    { run: RUN2, index: 1 },
    { run: RUN2, index: 2 },
  ]);
});

test("a slow segment from a run still files in order behind its successors", () => {
  const RUN = 5000;
  const taken = [
    { sortOrder: 0, storagePath: runPath(RUN, 0) },
    { sortOrder: 1, storagePath: runPath(RUN, 1) },
    { sortOrder: 3, storagePath: runPath(RUN, 3) },
  ];
  assert.deepEqual(recordingSegmentSlot(2, runPath(RUN, 2), taken), {
    kind: "insert",
    sortOrder: 2,
  });
});

test("a new run whose first segment is not index 0 still leaves room for its earlier ones", () => {
  const taken = [{ sortOrder: 0, storagePath: runPath(1, 0) }];
  // Run 2's segments 0 and 1 are still uploading when segment 2 registers.
  const s2 = recordingSegmentSlot(2, runPath(2, 2), taken);
  assert.deepEqual(s2, { kind: "insert", sortOrder: 3 });
  taken.push({ sortOrder: 3, storagePath: runPath(2, 2) });
  assert.deepEqual(recordingSegmentSlot(0, runPath(2, 0), taken), {
    kind: "insert",
    sortOrder: 1,
  });
});

test("a run's slot held by a different file goes after the last, never over it", () => {
  const taken = [
    { sortOrder: 0, storagePath: runPath(1, 0) },
    // A pre-run file squatting on run 1's next slot.
    { sortOrder: 1, storagePath: "e/recording/segment-0001-99.webm" },
  ];
  assert.deepEqual(recordingSegmentSlot(1, runPath(1, 1), taken), {
    kind: "insert",
    sortOrder: 2,
  });
});

test("two minutes of recording fits well inside a 50 MB upload limit", () => {
  // Supabase's default global upload limit binds every signed upload, whatever
  // the bucket says. Nominal size must leave room for VBR overshoot.
  const bytes =
    ((RECORDING_VIDEO_BITRATE + RECORDING_AUDIO_BITRATE) / 8) *
    RECORDING_SEGMENT_SECONDS;
  assert.ok(bytes * 2 < 50 * 1024 * 1024, `${bytes} bytes per segment`);
});

// ---------------------------------------------------------------------------
// One recorder per webinar
// ---------------------------------------------------------------------------

test("the lowest user id present records, staff or guest alike", () => {
  assert.equal(electRecorder(["u3", "u1", "u2"]), "u1");
  // A guest speaker's id is just an id: nothing about who they are enters it,
  // so no browser can hold a different fact about them than another does.
  assert.equal(electRecorder(["b-staff", "a-guest"]), "a-guest");
  assert.equal(electRecorder([]), null);
  assert.equal(electRecorder(["", "z"]), "z");
});

test("every browser in the room elects the same recorder", () => {
  const room = ["u3", "u2", "u1"];
  // Each browser sees itself plus the others, in whatever order its
  // connections came up — and none of them consults the page's speaker list,
  // which a guest who claimed their slot after a co-host's page loaded would
  // make disagree.
  const views = [room, [...room].reverse(), [room[1], room[0], room[2]]];
  const elected = views.map((v) => electRecorder(v));
  assert.deepEqual(elected, ["u1", "u1", "u1"]);
});

test("a co-host still connecting counts as present only while settling", () => {
  assert.equal(presentForRecording("live", false), true);
  assert.equal(presentForRecording("reconnecting", false), true);
  assert.equal(presentForRecording("connecting", true), true);
  assert.equal(presentForRecording("connecting", false), false);
  assert.equal(presentForRecording("failed", true), false);
  assert.equal(presentForRecording("idle", true), false);
});

test("a co-host who dropped counts as present for a bounded grace, not forever", () => {
  // A wifi handover: back well inside the grace, nobody else takes over.
  assert.equal(presentForRecording("reconnecting", false, 20_000), true);
  assert.equal(
    presentForRecording("reconnecting", false, RECORDER_RECONNECT_GRACE_MS),
    true,
  );
  // A laptop that died without a goodbye stops holding the election.
  assert.equal(
    presentForRecording("reconnecting", false, RECORDER_RECONNECT_GRACE_MS + 1),
    false,
  );
  // The bound is about "reconnecting" only; a live connection is present.
  assert.equal(presentForRecording("live", false, RECORDER_RECONNECT_GRACE_MS * 10), true);
});

const NOW = new Date("2026-09-26T18:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

test("the server refuses a segment while a present, lower-id host is recording", () => {
  const recent = [{ userId: "a", at: ago(60_000) }];
  assert.equal(
    recordingRival({ callerId: "b", recent, present: new Set(["a", "b"]), now: NOW }),
    "a",
  );
});

test("the rightful recorder is never refused by a stub from someone ranked below", () => {
  // A second host recorded a few seconds before seeing the first, and that
  // stub registered first. The lower id's segment must still land.
  const recent = [{ userId: "b", at: ago(5_000) }];
  assert.equal(
    recordingRival({ callerId: "a", recent, present: null, now: NOW }),
    null,
  );
});

test("a handover works once the old recorder has left or its lease has run out", () => {
  const recent = [{ userId: "a", at: ago(30_000) }];
  // Still in the room: refused.
  assert.equal(
    recordingRival({ callerId: "b", recent, present: new Set(["a"]), now: NOW }),
    "a",
  );
  // Left the room: the next in line carries on at once.
  assert.equal(
    recordingRival({ callerId: "b", recent, present: new Set(["b"]), now: NOW }),
    null,
  );
  // Attendance unreadable: the lease is the only clock, and it runs out.
  assert.equal(
    recordingRival({
      callerId: "b",
      recent: [{ userId: "a", at: ago(RECORDER_LEASE_MS + 1) }],
      present: null,
      now: NOW,
    }),
    null,
  );
});

test("a returning recorder's old registration does not refuse the host who covered for them", () => {
  // A left at t0 (its final flush registered then) and came back three
  // minutes later. B covered the gap, and is now flushing the segment it
  // began after A's last registration — the lease alone would refuse it.
  const recent = [{ userId: "a", at: ago(3 * 60_000) }];
  const start = recordingSegmentStart(NOW, 65);
  assert.equal(
    recordingRival({
      callerId: "b",
      recent,
      present: new Set(["a", "b"]),
      now: NOW,
      segmentStartMs: start,
    }),
    null,
  );
  // Without a segment start (the admin upload path), the lease still binds.
  assert.equal(
    recordingRival({ callerId: "b", recent, present: new Set(["a", "b"]), now: NOW }),
    "a",
  );
});

test("a host recording alongside the recorder is still refused", () => {
  // The rival registered DURING the caller's two-minute segment: both were
  // recording at once, and the lower id keeps it.
  const recent = [{ userId: "a", at: ago(40_000) }];
  assert.equal(
    recordingRival({
      callerId: "b",
      recent,
      present: new Set(["a", "b"]),
      now: NOW,
      segmentStartMs: recordingSegmentStart(NOW, 120),
    }),
    "a",
  );
});

test("a segment's start comes from its length on the server's clock", () => {
  assert.equal(recordingSegmentStart(NOW, 120), NOW.getTime() - 120_000);
  assert.equal(recordingSegmentStart(NOW, 0), NOW.getTime());
  // A negative length is clamped rather than dating the segment in the future.
  assert.equal(recordingSegmentStart(NOW, -5), NOW.getTime());
  // No usable length: no start, so every registration in the lease counts.
  assert.equal(recordingSegmentStart(NOW, undefined), undefined);
  assert.equal(recordingSegmentStart(NOW, null), undefined);
  assert.equal(recordingSegmentStart(NOW, Number.NaN), undefined);
});

test("a host is never their own rival, so a reload carries straight on", () => {
  assert.equal(
    recordingRival({
      callerId: "s",
      recent: [{ userId: "s", at: ago(1_000) }],
      present: null,
      now: NOW,
    }),
    null,
  );
});
