import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveAiTeamContext } from "./ai/team-context.ts";
import { buildCurriculumContext, buildSystemPrompt } from "./ai/system-prompt.ts";

test("AI team context accepts a pinned team only while the asker is a member", () => {
  assert.equal(resolveAiTeamContext("team-a", ["team-a"]), "team-a");
  assert.equal(resolveAiTeamContext("team-a", []), null, "Leaving a team revokes a saved conversation's retrieval");
  assert.equal(resolveAiTeamContext("team-b", ["team-a"]), null, "Editing an owned conversation cannot grant access to another team");
  assert.equal(resolveAiTeamContext("team-b", []), null, "A solo student cannot pin someone else's team");
});

test("AI team context never blends teams or silently substitutes an unauthorized pin", () => {
  assert.equal(resolveAiTeamContext(null, ["team-a"]), "team-a");
  assert.equal(resolveAiTeamContext(null, []), null);
  assert.equal(resolveAiTeamContext(null, ["team-a", "team-b"]), null);
  assert.equal(resolveAiTeamContext("team-b", ["team-a", "team-b"]), "team-b");
  assert.equal(resolveAiTeamContext("team-c", ["team-a", "team-b"]), null);
  assert.equal(resolveAiTeamContext(undefined, ["team-a", "team-a"]), "team-a");
});

test("AI curriculum context reads real descriptions in teaching order without dumping whole lessons", () => {
  const longDescription = `## Goal\n\nInterview a real user. ${"private long lesson text ".repeat(80)}END_OF_FULL_LESSON`;
  const context = buildCurriculumContext([
    { week: 2, title: "Validate", summary: "Observe behavior", lessons: [
      { position: 2, title: "Second lesson", description: "Test demand" },
      { position: 1, title: "First lesson", description: longDescription },
    ] },
    { week: 1, title: "Kickoff", lessons: null },
  ]);
  assert.match(context, /First lesson — ## Goal Interview a real user/);
  assert.match(context, /Observe behavior/);
  assert.ok(context.indexOf("Week 1") < context.indexOf("Week 2"));
  assert.ok(context.indexOf("First lesson") < context.indexOf("Second lesson"));
  assert.ok(!context.includes("END_OF_FULL_LESSON"));
  assert.ok(context.length < 700, "Only bounded excerpts belong in the corpus");
});

test("AI program instructions use the published schedule and make no fabricated award promise", () => {
  const prompt = buildSystemPrompt({ studentName: "Test founder", startupContext: null });
  assert.match(prompt, /Demo Day project showcase/);
  assert.match(prompt, /published Events page/);
  assert.match(prompt, /Do not promise grants, prizes, sponsors, judges, guests, or funding/);
  assert.doesNotMatch(prompt, /sponsor-funded grant panel|that awards cash prizes/);
  assert.match(prompt, /untrusted information/);
});
