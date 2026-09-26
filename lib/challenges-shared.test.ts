import { test } from "node:test";
import assert from "node:assert/strict";
import {
  challengeWindowState,
  isChallengeOpen,
  type Challenge,
} from "./challenges-shared.ts";

// Run with `npm test`. The window helper is a gate, so these cover the cases
// that let the WRONG state through — above all a challenge whose window is
// still ahead reading as "closed", which told visitors it had wrapped up.

const NOW = new Date("2026-09-26T12:00:00Z").getTime();

function challenge(over: Partial<Challenge>): Challenge {
  return {
    status: "active",
    opensAt: null,
    closesAt: null,
    ...over,
  } as Challenge;
}

test("open when active with no window set", () => {
  assert.equal(challengeWindowState(challenge({}), NOW), "open");
});

test("upcoming while opensAt is still ahead", () => {
  const c = challenge({
    opensAt: "2026-10-01T04:00:00Z",
    closesAt: "2026-10-11T03:59:59Z",
  });
  assert.equal(challengeWindowState(c, NOW), "upcoming");
  assert.equal(isChallengeOpen(c, NOW), false);
});

test("open once opensAt has passed and closesAt has not", () => {
  const c = challenge({
    opensAt: "2026-10-01T04:00:00Z",
    closesAt: "2026-10-11T03:59:59Z",
  });
  const during = new Date("2026-10-05T12:00:00Z").getTime();
  assert.equal(challengeWindowState(c, during), "open");
  assert.equal(isChallengeOpen(c, during), true);
});

test("closed once closesAt has passed", () => {
  const c = challenge({
    opensAt: "2026-10-01T04:00:00Z",
    closesAt: "2026-10-11T03:59:59Z",
  });
  const after = new Date("2026-10-12T00:00:00Z").getTime();
  assert.equal(challengeWindowState(c, after), "closed");
});

test("boundaries are inclusive at both ends", () => {
  const opens = "2026-10-01T04:00:00Z";
  const closes = "2026-10-11T03:59:59Z";
  const c = challenge({ opensAt: opens, closesAt: closes });
  assert.equal(challengeWindowState(c, new Date(opens).getTime()), "open");
  assert.equal(challengeWindowState(c, new Date(closes).getTime()), "open");
});

test("a non-active challenge is never upcoming, whatever its window says", () => {
  for (const status of ["draft", "closed", "archived"] as const) {
    const c = challenge({ status, opensAt: "2026-10-01T04:00:00Z" });
    assert.equal(challengeWindowState(c, NOW), "closed");
    assert.equal(isChallengeOpen(c, NOW), false);
  }
});

// ---------------------------------------------------------------------------
// 0087 — hackathon revamp: validation, prizes, referrals, phases.
// ---------------------------------------------------------------------------
import {
  validateAnswers,
  sanitizeQuestions,
  sanitizePrizes,
  prizeHeadline,
  mergeQualifiedReferrals,
  challengePhase,
  canRegister,
  requiredProgress,
  blankQuestion,
  shortName,
  QUESTION_PRESETS,
} from "./challenges-shared.ts";

const Q = (over: Parameters<typeof blankQuestion>[0]) => blankQuestion({ label: "Q", ...over });

test("draft mode keeps partial answers and reports nothing", () => {
  const qs = [Q({ id: "a", required: true }), Q({ id: "b", type: "url", required: true })];
  const r = validateAnswers(qs, { a: "hi" }, { mode: "draft" });
  assert.deepEqual(r.errors, {});
  assert.equal(r.answers.a, "hi");
});

test("submit mode enforces required, urls and char limits", () => {
  const qs = [
    Q({ id: "name", required: true, maxLength: 5 }),
    Q({ id: "link", type: "url" }),
    Q({ id: "ok", type: "checkbox", required: true }),
  ];
  const r = validateAnswers(qs, { name: "toolong", link: "github.com/x", ok: false }, { mode: "submit" });
  assert.match(r.errors.name, /under 5/);
  assert.match(r.errors.link, /https/);
  assert.match(r.errors.ok, /confirm/);
});

test("section headings are never required and collect nothing", () => {
  const qs = sanitizeQuestions([{ id: "s", type: "section", label: "Part 1", required: true }]);
  assert.equal(qs[0].required, false);
  const r = validateAnswers(qs, { s: "x" }, { mode: "submit" });
  assert.equal("s" in r.answers, false);
});

test("choice answers are limited to the defined options", () => {
  const qs = [
    Q({ id: "one", type: "select", options: ["A", "B"] }),
    Q({ id: "many", type: "multi_select", options: ["X", "Y", "Z"] }),
  ];
  const r = validateAnswers(qs, { one: "C", many: ["Y", "nope", "X"] }, { mode: "draft" });
  assert.equal(r.answers.one, "");
  assert.deepEqual(r.answers.many, ["X", "Y"]);
});

test("files outside the entrant's own folder are dropped", () => {
  const qs = [Q({ id: "shots", type: "file", maxFiles: 3 })];
  const r = validateAnswers(
    qs,
    {
      shots: [
        { path: "c1/u1/shots/1.png", name: "1.png", size: 10, type: "image/png" },
        { path: "c1/someone-else/2.png", name: "2.png", size: 10, type: "image/png" },
      ],
    },
    { mode: "submit", uploadPrefix: "c1/u1/" },
  );
  assert.equal((r.answers.shots as any[]).length, 1);
});

test("an uploaded video from another user's folder is cleared", () => {
  const qs = [Q({ id: "v", type: "video" })];
  const r = validateAnswers(qs, { v: "upload:c1/other/v.mp4" }, { mode: "submit", uploadPrefix: "c1/me/" });
  assert.equal(r.answers.v, "");
});

test("team rows need names and valid emails on submit", () => {
  const qs = [Q({ id: "t", type: "team", maxTeam: 2 })];
  const bad = validateAnswers(qs, { t: [{ name: "Ana", email: "nope" }] }, { mode: "submit" });
  assert.match(bad.errors.t, /valid email/);
  const good = validateAnswers(qs, { t: [{ name: "Ana", email: "a@b.co" }, { name: "B", email: "" }, { name: "C", email: "" }] }, { mode: "submit" });
  assert.equal(good.errors.t, undefined);
  assert.equal((good.answers.t as any[]).length, 2);
});

test("required progress counts only required input questions", () => {
  const qs = [Q({ id: "a", required: true }), Q({ id: "b" }), Q({ id: "s", type: "section" }), Q({ id: "c", type: "checkbox", required: true })];
  assert.deepEqual(requiredProgress(qs, { a: "x", c: true }), { done: 2, total: 2 });
  assert.deepEqual(requiredProgress(qs, { a: " " }), { done: 0, total: 2 });
});

test("prize headline combines cash and object prizes", () => {
  const prizes = sanitizePrizes([
    { kind: "cash", valueCents: 50000, quantity: 1, place: "1st" },
    { kind: "cash", valueCents: 25000, quantity: 1, place: "2nd" },
    { kind: "item", title: "Ray-Ban Meta glasses", place: "Grand prize" },
  ]);
  assert.equal(prizeHeadline({ prizeLabel: "", prizes }), "$750 + Ray-Ban Meta glasses");
  assert.equal(prizeHeadline({ prizeLabel: "Custom!", prizes }), "Custom!");
  assert.equal(prizeHeadline({ prizeLabel: "", prizes: prizes.slice(0, 2) }), "$750 in prizes");
});

test("untitled non-cash prizes and bad image URLs are dropped", () => {
  const p = sanitizePrizes([{ kind: "item", title: "" }, { kind: "item", title: "Hoodie", imageUrl: "javascript:alert(1)" }]);
  assert.equal(p.length, 1);
  assert.equal(p[0].imageUrl, null);
});

test("referrals: dedupe, no self-referral, only after the challenge was created", () => {
  const since = "2026-09-01T00:00:00Z";
  const merged = mergeQualifiedReferrals(
    {
      registrations: [
        { user_id: "friend1", created_at: "2026-09-05T00:00:00Z" },
        { user_id: "me", created_at: "2026-09-05T00:00:00Z" },
        { user_id: "old", created_at: "2026-08-01T00:00:00Z" },
      ],
      applications: [
        { user_id: "friend1", submitted_at: "2026-09-02T00:00:00Z" },
        { user_id: "friend2", submitted_at: "2026-09-10T00:00:00Z" },
        { user_id: "drafty", submitted_at: null },
      ],
    },
    { referrerId: "me", since },
  );
  assert.deepEqual(merged.map((m) => m.userId), ["friend1", "friend2"]);
  // friend1 applied before registering — earliest action wins.
  assert.equal(merged[0].source, "applied");
});

test("phases: upcoming → live → judging → ended", () => {
  const base = { status: "active" as const, opensAt: "2026-10-01T00:00:00Z", closesAt: "2026-10-05T00:00:00Z", resultsAt: "2026-10-10T00:00:00Z", winnersPublished: false };
  assert.equal(challengePhase(base, Date.parse("2026-09-30T00:00:00Z")), "upcoming");
  assert.equal(challengePhase(base, Date.parse("2026-10-02T00:00:00Z")), "live");
  assert.equal(challengePhase(base, Date.parse("2026-10-06T00:00:00Z")), "judging");
  assert.equal(challengePhase(base, Date.parse("2026-10-11T00:00:00Z")), "ended");
  assert.equal(challengePhase({ ...base, winnersPublished: true }, Date.parse("2026-10-06T00:00:00Z")), "ended");
  assert.equal(challengePhase({ ...base, status: "draft" }, NOW), "draft");
});

test("registration opens before submissions and closes at the deadline", () => {
  const c = { status: "active" as const, closesAt: "2026-10-05T00:00:00Z" };
  assert.equal(canRegister(c, Date.parse("2026-09-01T00:00:00Z")), true);
  assert.equal(canRegister(c, Date.parse("2026-10-06T00:00:00Z")), false);
  assert.equal(canRegister({ ...c, status: "closed" }, NOW), false);
});

test("every quick-add preset produces a question that survives sanitizing", () => {
  const made = QUESTION_PRESETS.map((p) => p.make());
  assert.equal(sanitizeQuestions(made).length, made.length);
});

test("shortName keeps first name and last initial", () => {
  assert.equal(shortName("Maya Rodriguez"), "Maya R.");
  assert.equal(shortName("Cher"), "Cher");
  assert.equal(shortName(null), "A friend");
});
