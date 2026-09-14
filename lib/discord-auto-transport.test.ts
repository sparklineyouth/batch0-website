import test from "node:test";
import assert from "node:assert/strict";
import {
  DiscordAutoTransport, DiscordTransportError, effectiveDiscordPermissions,
} from "./discord-auto-transport.ts";

const TOKEN = "synthetic-token-not-for-logs";
const b = (n: number) => BigInt(1) << BigInt(n);
const read = b(10) | b(16), send = b(11), threadSend = b(38);
type Step = {path: string; method?: string; data?: unknown; status?: number; headers?: Record<string, string>; body?: (body: Record<string, unknown>) => void};
function fixture(steps: Step[], options: {now?: () => number; maxRequests?: number} = {}) {
  const calls: {path: string; method: string; body?: Record<string, unknown>}[] = [];
  const fake: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "https://discord.com");
    assert.equal(init?.redirect, "error");
    assert.equal(new Headers(init?.headers).get("authorization"), `Bot ${TOKEN}`);
    const path = url.pathname.slice("/api/v10".length) + url.search;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({path, method: String(init?.method), body});
    const step = steps.shift(); assert.ok(step, `Unexpected request ${path}`);
    assert.equal(path, step.path); assert.equal(init?.method, step.method ?? "GET");
    step.body?.(body);
    return new Response(JSON.stringify(step.data ?? {}), {status: step.status ?? 200, headers: {"content-type": "application/json", ...step.headers}});
  };
  return {transport: new DiscordAutoTransport({token: TOKEN, guildId: "1", fetch: fake, ...options}), calls, done: () => assert.equal(steps.length, 0)};
}
function message(id: string, extra: Record<string, unknown> = {}) {
  return {id, channel_id: "10", author: {id: "9", bot: false}, content: `Question ${id}?`, type: 0, timestamp: "2026-09-14T12:00:00.000Z", ...extra};
}
function app(flags: number, extra: Record<string, unknown> = {}) { return {id: "2", flags, approximate_guild_count: 1, interactions_endpoint_url: "https://example.com/interactions", ...extra}; }
function discoverySteps(channels: unknown[], threads: unknown[] = [], members: unknown[] = [], permissions = read | send | threadSend | b(20), memberExtra = {}): Step[] {
  return [
    {path: "/users/@me", data: {id: "2", bot: true}},
    {path: "/guilds/1/members/2", data: {roles: ["3"], ...memberExtra}},
    {path: "/guilds/1/roles", data: [{id: "1", permissions: "0"}, {id: "3", permissions: String(permissions)}]},
    {path: "/guilds/1/channels", data: channels},
    {path: "/guilds/1/threads/active", data: {threads, members}},
  ];
}
const channel = (id: string, type = 0, extra = {}) => ({id, type, name: `channel-${id}`, parent_id: null, permission_overwrites: [], ...extra});
const thread = (id: string, type = 11, extra = {}) => channel(id, type, {parent_id: "10", thread_metadata: {archived: false, locked: false}, ...extra});
const isError = (kind: string) => (error: unknown) => error instanceof DiscordTransportError && error.kind === kind;

test("permission precedence applies everyone, role unions, then member overrides", () => {
  const result = effectiveDiscordPermissions({guildId: "1", botId: "2", roleIds: ["3", "4"], roles: [{id: "1", permissions: String(read | send)}], overwrites: [
    {id: "1", type: 0, deny: String(send), allow: "0"},
    {id: "3", type: 0, deny: String(b(16)), allow: String(send)},
    {id: "4", type: 0, deny: String(send), allow: String(b(16))},
    {id: "2", type: 1, deny: String(send), allow: "0"},
  ]});
  assert.equal(result & read, read); assert.equal(result & send, BigInt(0));
});

test("role overwrite order cannot change the result and high thread permission bits survive", () => {
  const args = {guildId: "1", botId: "2", roleIds: ["3", "4"], roles: [{id: "1", permissions: "0"}], overwrites: [
    {id: "3", type: 0, deny: String(threadSend), allow: "0"},
    {id: "4", type: 0, deny: "0", allow: String(threadSend)},
  ]};
  assert.equal(effectiveDiscordPermissions(args), threadSend);
  assert.equal(effectiveDiscordPermissions({...args, overwrites: [...args.overwrites].reverse()}), threadSend);
});

test("administrator bypasses overwrites without needing new permissions", () => {
  const permissions = effectiveDiscordPermissions({guildId: "1", botId: "2", roleIds: ["3"], roles: [{id: "3", permissions: String(b(3))}], overwrites: [{id: "2", type: 1, deny: String(read), allow: "0"}]});
  assert.equal(permissions & (read | threadSend), read | threadSend);
});

test("discovery includes readable text, announcement, voice/stage and joined private/public threads", async () => {
  const f = fixture(discoverySteps([
    channel("10"), channel("11", 5, {permission_overwrites: [{id: "2", type: 1, deny: String(send), allow: "0"}]}),
    channel("12", 2), channel("13", 13), channel("14", 15), channel("15", 4),
    channel("16", 2, {permission_overwrites: [{id: "1", type: 0, deny: String(b(20)), allow: "0"}]}),
  ], [thread("20"), thread("21", 12), thread("22", 12), thread("23", 11, {thread_metadata: {archived: false, locked: true}}), thread("24", 11, {thread_metadata: {archived: true, locked: false}})], [{id: "21"}]));
  const result = await f.transport.discoverChannels();
  assert.deepEqual(result.channels.map(c => c.id), ["10", "11", "12", "13", "20", "21", "23", "24"]);
  assert.equal(result.channels.find(c => c.id === "11")?.canReply, false);
  assert.equal(result.channels.find(c => c.id === "20")?.canReply, true);
  assert.equal(result.channels.find(c => c.id === "23")?.canReply, false);
  assert.equal(result.channels.find(c => c.id === "24")?.canReply, false);
  assert.deepEqual(result.skipped, [{id: "16", reason: "cannot_read_history"}, {id: "22", reason: "private_thread_not_joined"}]);
  assert.ok(f.calls.every(c => c.method === "GET")); f.done();
});

test("threads inherit parent visibility; send-in-threads is independent of send-messages", async () => {
  const f = fixture(discoverySteps([
    channel("10"), channel("11", 0, {permission_overwrites: [{id: "2", type: 1, deny: String(b(10)), allow: "0"}]}),
  ], [thread("20"), thread("21", 11, {parent_id: "11"}), thread("22", 11, {parent_id: "99"})], [], read | threadSend));
  const result = await f.transport.discoverChannels();
  assert.equal(result.channels.find(c => c.id === "10")?.canReply, false);
  assert.equal(result.channels.find(c => c.id === "20")?.canReply, true);
  assert.deepEqual(result.skipped.map(s => s.reason), ["cannot_read_history", "cannot_read_history", "missing_parent"]); f.done();
});

test("a timed-out bot can read but cannot reply", async () => {
  const f = fixture(discoverySteps([channel("10")], [], [], read | send, {communication_disabled_until: "2099-01-01T00:00:00Z"}));
  const result = await f.transport.discoverChannels(); assert.equal(result.channels[0].canReply, false); f.done();
});

test("forum and text threads retain their category ancestor for exclusion policy", async () => {
  const f = fixture(discoverySteps([
    channel("30", 4), channel("14", 15, {parent_id: "30"}), channel("10", 0, {parent_id: "30"}),
  ], [thread("20", 11, {parent_id: "14"}), thread("21")]));
  const result = await f.transport.discoverChannels();
  assert.deepEqual(result.channels.map(c => ({id: c.id, parentId: c.parentId, categoryId: c.categoryId})), [
    {id: "10", parentId: "30", categoryId: "30"}, {id: "20", parentId: "14", categoryId: "30"}, {id: "21", parentId: "10", categoryId: "30"},
  ]); f.done();
});

test("health reads identity and content intent without any mutation", async () => {
  const f = fixture([{path: "/users/@me", data: {id: "2", bot: true}}, {path: "/applications/@me", data: app(Number(b(19) | b(23)))}]);
  const result = await f.transport.health();
  assert.equal(result.messageContentEnabled, true); assert.equal(result.messageContentLimited, true); assert.equal(result.messageContentApproved, false);
  assert.equal(result.botId, "2"); assert.equal(result.applicationFlags, String(b(19) | b(23))); assert.ok(f.calls.every(c => c.method === "GET")); f.done();
});

test("health rejects non-bot or mismatched identity", async () => {
  const f = fixture([{path: "/users/@me", data: {id: "9", bot: true}}, {path: "/applications/@me", data: app(0)}]);
  await assert.rejects(f.transport.health(), isError("protocol")); f.done();
});

test("limited intent opt-in preserves every existing application flag", async () => {
  const before = Number(b(13) | b(15) | b(23)), after = Number(BigInt(before) | b(19));
  const f = fixture([{path: "/applications/@me", data: app(before)}, {path: "/applications/@me", method: "PATCH", body: body => assert.deepEqual(body, {flags: after}), data: app(after)}]);
  assert.equal((await f.transport.enableLimitedMessageContent(String(before))).applicationFlags, String(after)); f.done();
});

test("limited intent refuses stale flags and does not patch an already enabled app", async () => {
  const conflict = fixture([{path: "/applications/@me", data: app(8)}]);
  await assert.rejects(conflict.transport.enableLimitedMessageContent("0"), isError("conflict")); conflict.done();
  const enabled = fixture([{path: "/applications/@me", data: app(Number(b(18)), {approximate_guild_count: 100})}]);
  assert.equal((await enabled.transport.enableLimitedMessageContent(String(b(18)))).messageContentEnabled, true); enabled.done();
});

test("limited intent refuses large unapproved apps and detects provider flag loss", async () => {
  const large = fixture([{path: "/applications/@me", data: app(0, {approximate_guild_count: 100})}]);
  await assert.rejects(large.transport.enableLimitedMessageContent("0"), isError("unsupported")); large.done();
  const loss = fixture([{path: "/applications/@me", data: app(8)}, {path: "/applications/@me", method: "PATCH", data: app(Number(b(19)))}]);
  await assert.rejects(loss.transport.enableLimitedMessageContent("8"), isError("protocol")); loss.done();
});

test("message pages normalize newest-first snowflakes without Number precision loss", async () => {
  const f = fixture([{path: "/channels/10/messages?limit=2", data: [message("9007199254740993"), message("9007199254740992")]}]);
  const page = await f.transport.fetchMessages("10", {limit: 2});
  assert.deepEqual(page.messages.map(m => m.id), ["9007199254740992", "9007199254740993"]); assert.equal(page.full, true); f.done();
});

test("after and before cursors cannot be combined; invalid IDs never reach fetch", async () => {
  const f = fixture([]);
  await assert.rejects(f.transport.fetchMessages("10", {after: "100", before: "200"}), isError("configuration"));
  await assert.rejects(f.transport.fetchMessages("../users/@me"), isError("configuration"));
  assert.equal(f.calls.length, 0);
});

test("after pagination fills the older gap before declaring the cursor safe", async () => {
  const f = fixture([
    {path: "/channels/10/messages?limit=2&after=100", data: [message("105"), message("104")]},
    {path: "/channels/10/messages?limit=2&before=104", data: [message("103"), message("102")]},
    {path: "/channels/10/messages?limit=2&before=102", data: [message("101"), message("100")]},
  ]);
  const result = await f.transport.fetchAfter("10", "100", {limit: 2});
  assert.deepEqual(result.messages.map(m => m.id), ["101", "102", "103", "104", "105"]);
  assert.equal(result.complete, true); assert.equal(result.nextBefore, null); assert.equal(result.highWaterId, "105"); f.done();
});

test("bounded after pagination reports backlog instead of skipping older messages", async () => {
  const f = fixture([
    {path: "/channels/10/messages?limit=2&after=100", data: [message("105"), message("104")]},
    {path: "/channels/10/messages?limit=2&before=104", data: [message("103"), message("102")]},
  ]);
  const result = await f.transport.fetchAfter("10", "100", {limit: 2, maxPages: 2});
  assert.equal(result.complete, false); assert.equal(result.nextBefore, "102"); assert.equal(result.highWaterId, "105"); f.done();
});

test("empty after pages finish without additional requests", async () => {
  const f = fixture([{path: "/channels/10/messages?limit=100&after=100", data: []}]);
  assert.deepEqual(await f.transport.fetchAfter("10", "100"), {messages: [], complete: true, nextBefore: null, highWaterId: null}); f.done();
});

test("source reread returns current edited content and maps deletion to not_found", async () => {
  const f = fixture([{path: "/channels/10/messages/100", data: message("100", {content: "Edited question?"})}, {path: "/channels/10/messages/101", status: 404, data: {code: 10008, message: "Unknown Message"}}]);
  assert.equal((await f.transport.fetchMessage("10", "100")).content, "Edited question?");
  await assert.rejects(f.transport.fetchMessage("10", "101"), e => isError("not_found")(e) && (e as DiscordTransportError).discordCode === 10008); f.done();
});

test("reply targets the source channel, deduplicates, suppresses mentions and requires source existence", async () => {
  const f = fixture([{path: "/channels/10/messages", method: "POST", body: body => assert.deepEqual(body, {
    content: "A short answer.", nonce: "100", enforce_nonce: true, allowed_mentions: {parse: [], replied_user: false},
    message_reference: {message_id: "100", channel_id: "10", fail_if_not_exists: true},
  }), data: {id: "200", channel_id: "10"}}]);
  assert.deepEqual(await f.transport.replyToMessage({channelId: "10", messageId: "100", content: "A short answer."}), {id: "200", channelId: "10"}); f.done();
});

test("replies reject empty/oversized text and invalid source IDs before network writes", async () => {
  const f = fixture([]);
  for (const content of [" ", "x".repeat(2001)]) await assert.rejects(f.transport.replyToMessage({channelId: "10", messageId: "100", content}), isError("configuration"));
  await assert.rejects(f.transport.replyToMessage({channelId: "10", messageId: "100/other", content: "answer"}), isError("configuration"));
  assert.equal(f.calls.length, 0);
});

test("API failure messages never expose provider bodies or credentials", async () => {
  const f = fixture([{path: "/channels/10/messages?limit=100", status: 403, data: {code: 50013, message: `${TOKEN}: private response body`}}]);
  await assert.rejects(f.transport.fetchMessages("10"), error => {
    assert.ok(error instanceof DiscordTransportError); assert.equal(error.kind, "forbidden"); assert.equal(error.discordCode, 50013);
    assert.ok(!error.message.includes(TOKEN)); assert.ok(!error.message.includes("private response")); return true;
  }); f.done();
});

test("global rate limit blocks other routes without sleeping or making another request", async () => {
  let now = 1000;
  const f = fixture([{path: "/channels/10/messages?limit=100", status: 429, data: {retry_after: 1.5, global: true}}, {path: "/channels/11/messages?limit=100", data: []}], {now: () => now});
  await assert.rejects(f.transport.fetchMessages("10"), error => isError("rate_limit")(error) && (error as DiscordTransportError).global && (error as DiscordTransportError).retryAfterMs === 1500);
  await assert.rejects(f.transport.fetchMessages("11"), isError("rate_limit")); assert.equal(f.calls.length, 1);
  now += 1500; await f.transport.fetchMessages("11"); f.done();
});

test("remaining-zero bucket headers defer same channel but allow a different major resource", async () => {
  const f = fixture([{path: "/channels/10/messages?limit=100", data: [], headers: {"x-ratelimit-bucket": "bucket", "x-ratelimit-remaining": "0", "x-ratelimit-reset-after": "2"}}, {path: "/channels/11/messages?limit=100", data: []}], {now: () => 1000});
  await f.transport.fetchMessages("10");
  await assert.rejects(f.transport.fetchMessages("10"), error => isError("rate_limit")(error) && !(error as DiscordTransportError).global && (error as DiscordTransportError).retryAfterMs === 2000);
  await f.transport.fetchMessages("11"); f.done();
});

test("rate limits honor the longest provider delay and a header-only global limit", async () => {
  const f = fixture([{path: "/channels/10/messages?limit=100", status: 429, data: {retry_after: 0.5}, headers: {"retry-after": "2", "x-ratelimit-global": "true"}}], {now: () => 1000});
  await assert.rejects(f.transport.fetchMessages("10"), error => isError("rate_limit")(error) && (error as DiscordTransportError).global && (error as DiscordTransportError).retryAfterMs === 2000); f.done();
});

test("request budget is enforced before issuing another API call", async () => {
  const f = fixture([{path: "/channels/10/messages?limit=100", data: []}], {maxRequests: 1});
  await f.transport.fetchMessages("10"); await assert.rejects(f.transport.fetchMessages("10"), isError("budget")); assert.equal(f.transport.requestsUsed, 1); f.done();
});

test("even concurrent callers issue at most one HTTP request at a time", async () => {
  let active = 0, maximum = 0;
  const fake: typeof fetch = async () => { active++; maximum = Math.max(maximum, active); await new Promise(resolve => setTimeout(resolve, 2)); active--; return Response.json([]); };
  const transport = new DiscordAutoTransport({token: TOKEN, guildId: "1", fetch: fake});
  await Promise.all([transport.fetchMessages("10"), transport.fetchMessages("11"), transport.fetchMessages("12")]);
  assert.equal(maximum, 1); assert.equal(transport.requestsUsed, 3);
});

test("aborted work makes no requests and a stalled request times out with a typed error", async () => {
  const controller = new AbortController(); controller.abort();
  const stopped = new DiscordAutoTransport({token: TOKEN, guildId: "1", signal: controller.signal, fetch: async () => { assert.fail("must not fetch"); }});
  await assert.rejects(stopped.fetchMessages("10"), isError("aborted"));
  const stalled = new DiscordAutoTransport({token: TOKEN, guildId: "1", timeoutMs: 5, fetch: async (_input, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new Error("private network detail")), {once: true});
  })});
  await assert.rejects(stalled.fetchMessages("10"), isError("timeout"));
});

test("network errors and cross-channel API responses are rejected without private text", async () => {
  const transport = new DiscordAutoTransport({token: TOKEN, guildId: "1", fetch: async () => { throw new Error(`Network URL includes ${TOKEN}`); }});
  await assert.rejects(transport.fetchMessages("10"), error => isError("network")(error) && !(error as Error).message.includes(TOKEN));
  const f = fixture([{path: "/channels/10/messages/100", data: message("100", {channel_id: "11"})}]);
  await assert.rejects(f.transport.fetchMessage("10", "100"), isError("protocol")); f.done();
});
