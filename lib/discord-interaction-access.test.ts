import { test } from "node:test";
import assert from "node:assert/strict";
import { allowedDiscordInteraction } from "./discord-interaction-access.ts";

test("Discord verification PING remains available without a configured guild", () => {
  assert.equal(allowedDiscordInteraction(1, undefined, undefined), true);
});

test("Discord commands require the configured guild", () => {
  assert.equal(allowedDiscordInteraction(2, "official", "official"), true);
  assert.equal(allowedDiscordInteraction(2, "foreign", "official"), false);
  assert.equal(allowedDiscordInteraction(2, undefined, "official"), false);
  assert.equal(allowedDiscordInteraction(2, "official", undefined), false);
  assert.equal(allowedDiscordInteraction(2, ["official"], "official"), false);
});

test("Discord onboarding DM interactions remain usable without allowing foreign-guild buttons", () => {
  for (const type of [3, 5]) {
    assert.equal(allowedDiscordInteraction(type, undefined, "official"), true);
    assert.equal(allowedDiscordInteraction(type, "official", "official"), true);
    assert.equal(allowedDiscordInteraction(type, "foreign", "official"), false);
    assert.equal(allowedDiscordInteraction(type, undefined, undefined), false);
  }
  assert.equal(allowedDiscordInteraction(99, undefined, "official"), false);
});
