import { test } from "node:test";
import assert from "node:assert/strict";
import { looksLikeQuestion, isQuestionCandidate, snowflakeAt, limitUtf8, buildQuestionInput, parseAutoAnswer, DISCORD_AUTO_SYSTEM, discordAutoCost } from "./discord-auto-policy.ts";

test("questions without mentions or punctuation, technical questions, and Unicode punctuation", () => {
  for (const s of ["How do I interview a customer", "any tips on pricing", "I'm stuck with deployment", "please explain the worksheet", "Can someone help with this", "does this work?", "这个怎么办？"]) assert.equal(looksLikeQuestion(s), true, s);
  for (const s of ["nice work everyone", "https://example.test/?q=test", "```js\nconst x = a ? b : c\n```", "`const value = a ? b : c`", "> How do I do this?", ">>> This is a quoted message\nHow does this work?", "/ask how does this work", "!"]) assert.equal(looksLikeQuestion(s), false, s);
});

test("source/channel, author, timestamp and type gates prevent loops and history replay", () => {
  const now = Date.parse("2026-09-14T20:00:00Z");
  const args = { now, guildId: "111111111111111111", channelId: "222222222222222222", botUserId: "333333333333333333", activatedAt: new Date(now - 60_000).toISOString() };
  const m = { id: snowflakeAt(now), channel_id: args.channelId, guild_id: args.guildId, author: {id: "444444444444444444"}, type:0, timestamp:new Date(now).toISOString(), content:"How do I test an idea?" };
  assert.equal(isQuestionCandidate(m,args),true);
  for (const patch of [{author:{id:args.botUserId}}, {author:{...m.author,bot:true}}, {webhook_id:"hook"}, {channel_id:"555555555555555555"}, {guild_id:"555555555555555555"}, {type:7}, {timestamp:new Date(now-120_000).toISOString()}, {timestamp:"bad"}, {timestamp:new Date(now+60_000).toISOString()}]) assert.equal(isQuestionCandidate({...m,...patch},args),false,JSON.stringify(patch));
  assert.equal(isQuestionCandidate({...m,timestamp:new Date(now-700_000).toISOString()},{...args,activatedAt:new Date(now-800_000).toISOString()}),false);
  assert.equal(isQuestionCandidate(m,{...args,activatedAt:"invalid"}),false);
  assert.equal(isQuestionCandidate(m,{...args,now:NaN}),false);
});

test("model input stays bounded and supplies only explicit same-channel text", () => {
  const request = buildQuestionInput("🦦".repeat(4000), ["A".repeat(5000), "same channel"]);
  const parsed=JSON.parse(request);
  assert.ok(Buffer.byteLength(parsed.latest_message)<=4000);
  assert.ok(Buffer.byteLength(parsed.same_channel_context)<=1200);
  assert.equal(limitUtf8("🦦a",4),"🦦");
  assert.deepEqual(Object.keys(parsed),["same_channel_context","latest_message"]);
  assert.match(DISCORD_AUTO_SYSTEM,/untrusted/);
  assert.match(DISCORD_AUTO_SYSTEM,/no private student\/team data/);
  assert.match(DISCORD_AUTO_SYSTEM,/https:\/\/batch0.org\/dashboard\/course/);
  assert.doesNotMatch(DISCORD_AUTO_SYSTEM,/\/dashboard\/learn/);
  assert.doesNotMatch(DISCORD_AUTO_SYSTEM,/grants of|cash prizes|sponsor-funded/i);
});

test("only valid structured answers are sent, labelled AI, bounded and without mentions", () => {
  for(const s of ["plain text",'{"answer":null}','{"answer":{}}','[]','{"answer":""}']) assert.equal(parseAutoAnswer(s),null);
  const result=parseAutoAnswer(JSON.stringify({answer:"@everyone <@123> "+"🦦".repeat(2000)}))!;
  assert.ok(result.length<2000);
  assert.ok(!result.includes("@"));
  assert.match(result,/Batch0 AI/);
  assert.equal(discordAutoCost(2000,700),5500);
  assert.throws(()=>discordAutoCost(-1,2));
});
