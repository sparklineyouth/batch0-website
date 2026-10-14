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
  isReaction,
  messagesNeedApproval,
  normalizeAudienceMode,
  normalizeChatMessage,
  normalizePoll,
  pollPercentages,
  pollVisibleToAudience,
  sortQuestions,
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
  // Record<AudienceMode, …> makes the typecheck fail on a mode missing here.
  const every = { private: true, moderated: true, open: true } satisfies Record<
    AudienceMode,
    true
  >;
  const visible = (Object.keys(every) as AudienceMode[]).filter(audienceCanSeeEachOther);
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
// live_mode helpers
// ---------------------------------------------------------------------------

test("both batch0-hosted modes are recognised as ours", () => {
  assert.equal(isHostedOnBatch0("hosted"), true);
  assert.equal(isHostedOnBatch0("premiere"), true);
  assert.equal(isHostedOnBatch0("external"), false);
  assert.equal(isHostedOnBatch0(null), false);
  assert.equal(isHostedOnBatch0(undefined), false);
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

test("the audience sees open polls and closed results, never a draft", () => {
  assert.equal(pollVisibleToAudience({ open: true, tally: [0, 0] }), true);
  assert.equal(
    pollVisibleToAudience({ open: false, tally: [2, 1] }),
    true,
    "Closing a poll (or End) keeps its result on screen",
  );
  assert.equal(
    pollVisibleToAudience({ open: false, tally: [0, 0] }),
    false,
    "A draft is the host's preparation — never opened, never voted on",
  );
});

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------

test("the queue: spotlight, then open by votes (ties as asked), then the rest", () => {
  const q = (
    id: string,
    extra: { status?: "open" | "answered" | "dismissed"; voteCount?: number; spotlighted?: boolean },
  ) => ({
    id,
    status: "open" as "open" | "answered" | "dismissed",
    voteCount: 0,
    spotlighted: false,
    createdAt: `2026-10-14T18:00:0${id}Z`,
    ...extra,
  });
  const sorted = sortQuestions([
    q("1", { status: "answered", voteCount: 9 }),
    q("2", { voteCount: 1 }),
    q("3", { voteCount: 5 }),
    q("4", { voteCount: 1 }),
    q("5", { spotlighted: true }),
    q("6", { status: "dismissed" }),
  ]);
  assert.deepEqual(
    sorted.map((x) => x.id),
    ["5", "3", "2", "4", "1", "6"],
  );
});

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

test("slides are PDF only, recognised by extension even with no MIME type", () => {
  // The room presents decks with pdf.js; a PowerPoint file cannot be shown.
  assert.equal(isDeckFile("Fundraising.pdf", ""), true);
  assert.equal(isDeckFile("Fundraising.pdf", "application/octet-stream"), true);
  assert.equal(isDeckFile("notes.PDF", null), true);
  assert.equal(isDeckFile("Fundraising.pptx", ""), false);
  assert.equal(
    isDeckFile(
      "Fundraising.pptx",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ),
    false,
  );
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
