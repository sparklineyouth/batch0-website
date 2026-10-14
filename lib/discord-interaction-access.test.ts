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

test("Discord onboarding DM buttons remain usable without allowing foreign-guild buttons", () => {
  assert.equal(allowedDiscordInteraction(3, undefined, "official"), true);
  assert.equal(allowedDiscordInteraction(3, "official", "official"), true);
  assert.equal(allowedDiscordInteraction(3, "foreign", "official"), false);
  assert.equal(allowedDiscordInteraction(3, undefined, undefined), false);
  // No modals remain (the /checkin form was the only one).
  assert.equal(allowedDiscordInteraction(5, undefined, "official"), false);
  assert.equal(allowedDiscordInteraction(99, undefined, "official"), false);
});
