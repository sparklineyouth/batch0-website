import { test } from "node:test";
import assert from "node:assert/strict";
import { discordChannelUrl, discordMessageUrl, isSnowflake } from "./discord-links.ts";

const GUILD = "1100000000000000001";
const CHANNEL = "1200000000000000002";
const MESSAGE = "1300000000000000003";

test("snowflakes are 17 to 20 digits and nothing else", () => {
  assert.equal(isSnowflake("12345678901234567"), true);
  assert.equal(isSnowflake("12345678901234567890"), true);
  assert.equal(isSnowflake("1234567890123456"), false);
  assert.equal(isSnowflake("123456789012345678901"), false);
  assert.equal(isSnowflake(" 1200000000000000002"), false);
  assert.equal(isSnowflake("1200000000000000002/x"), false);
  assert.equal(isSnowflake("12000000000000000a2"), false);
  assert.equal(isSnowflake(""), false);
  assert.equal(isSnowflake(undefined), false);
  assert.equal(isSnowflake(1200000000000000002), false);
});

test("a message link needs a guild, a channel and a message", () => {
  assert.equal(
    discordMessageUrl(GUILD, CHANNEL, MESSAGE),
    `https://discord.com/channels/${GUILD}/${CHANNEL}/${MESSAGE}`,
  );
  assert.equal(discordMessageUrl(undefined, CHANNEL, MESSAGE), null);
  assert.equal(discordMessageUrl("", CHANNEL, MESSAGE), null);
  assert.equal(discordMessageUrl(GUILD, "", MESSAGE), null);
  assert.equal(discordMessageUrl(GUILD, CHANNEL, null), null);
});

test("ids that are not snowflakes never reach the URL", () => {
  for (const bad of ["abc", "123", "1".repeat(21), "../1200000000000000002", "1200000000000000002?x=1"]) {
    assert.equal(discordMessageUrl(bad, CHANNEL, MESSAGE), null, `guild ${bad}`);
    assert.equal(discordMessageUrl(GUILD, bad, MESSAGE), null, `channel ${bad}`);
    assert.equal(discordMessageUrl(GUILD, CHANNEL, bad), null, `message ${bad}`);
  }
});

test("a channel link needs a guild and a channel", () => {
  assert.equal(discordChannelUrl(GUILD, CHANNEL), `https://discord.com/channels/${GUILD}/${CHANNEL}`);
  assert.equal(discordChannelUrl(undefined, CHANNEL), null);
  assert.equal(discordChannelUrl(GUILD, null), null);
  assert.equal(discordChannelUrl(GUILD, "not-an-id"), null);
});
