import { test } from "node:test";
import assert from "node:assert/strict";
import {
  audienceCanSeeEachOther,
  canBroadcast,
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
  AUDIENCE_MODES,
  MAX_CHAT_LENGTH,
  MAX_POLL_OPTIONS,
  type AudienceMode,
} from "./webinars.ts";

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
