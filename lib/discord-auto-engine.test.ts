import assert from "node:assert/strict";
import test from "node:test";
import { discordSourceHash, isExcludedDiscordChannel, runDiscordAutoQuestions } from "./discord-auto-engine.ts";
import { snowflakeAt } from "./discord-auto-policy.ts";
import { DiscordTransportError, type DiscordAutoTransport, type DiscordMessage, type DiscordReadableChannel } from "./discord-auto-transport.ts";
import type { DiscordAutoStore, DiscordAutoState, DiscordAutoLease, DiscordAutoJob, DiscordAutoCursor } from "./discord-auto-store.ts";
import type { AutoGeneration } from "./discord-auto-ai.ts";

// The separate SQL suite executes the actual migration. This durable fake tests
// orchestration across repeated invocations without making provider requests.
const NOW = Date.parse("2026-09-14T23:00:00Z");
const BOT = "100000000000000001", GUILD = "100000000000000002", USER = "100000000000000003";
let sequence = 0;
const id = (at = NOW - 1000) => (BigInt(snowflakeAt(at)) + BigInt(++sequence)).toString();
function channel(channelId = "100000000000000010", patch: Partial<DiscordReadableChannel> = {}): DiscordReadableChannel {
  return { id: channelId, name: "course-help", type: 0, parentId: null, kind: "text", canReply: true, archived: false, locked: false, ...patch };
}
function message(channelId: string, content = "How do I interview my first customer?", patch: Partial<DiscordMessage> = {}): DiscordMessage {
  return { id: id(), channelId, authorId: USER, authorBot: false, webhookId: null, content, type: 0,
    createdAt: new Date(NOW - 1000).toISOString(), referencedMessageId: null, ...patch };
}

function harness(channels: DiscordReadableChannel[] = [channel()]) {
  const state: DiscordAutoState = {
    enabled: true, masterEnabled: true, effectiveEnabled: true, excludedChannelIds: [],
    activationAt: new Date(NOW - 300000).toISOString(), activationSnowflake: snowflakeAt(NOW - 300000),
    dailyBudgetMicrousd: 250000, lifetimeBudgetMicrousd: 5000000, maxRepliesPerDay: 100,
    userCooldownSeconds: 60, channelCooldownSeconds: 60, budgetDay: "2026-09-14",
    dailySpentMicrousd: 0, dailyReservedMicrousd: 0, dailyCalls: 0,
    lifetimeSpentMicrousd: 0, lifetimeReservedMicrousd: 0,
    lastRunStartedAt: null, lastRunFinishedAt: null, lastError: null, lastRunSummary: {}, backoffUntil: null, leaseExpiresAt: null,
  };
  const jobs = new Map<string, DiscordAutoJob>();
  const cursors = new Map<string, DiscordAutoCursor>();
  const batches = new Map<string, DiscordMessage[]>();
  const sources = new Map<string, DiscordMessage>();
  const recent = new Map<string, DiscordMessage[]>();
  const incomplete = new Set<string>();
  const calls = { generate: [] as { question: string; context: string[] }[], send: [] as { channelId: string; messageId: string; content: string }[], polls: [] as string[], advances: [] as { channelId: string; messageId: string | null }[], releases: [] as unknown[] };
  let active: DiscordAutoLease | null = null, fence = 0;
  const hooks = {
    generateError: null as Error | null, sendError: null as Error | null,
    stateError: null as Error | null, claimError: null as Error | null,
    settleError: null as Error | null, beginSendError: null as Error | null,
    markSentError: null as Error | null, sourceError: null as Error | null,
    onGenerate: null as (() => void) | null,
    onBeginSend: null as (() => void) | null,
    replayBatches: false,
  };
  const check = (lease: DiscordAutoLease) => {
    if (!active || lease.leaseId !== active.leaseId || lease.fence !== active.fence) throw new Error("stale_lease");
  };
  function totals() {
    state.dailySpentMicrousd = [...jobs.values()].reduce((sum, j) => sum + (j.actual_microusd ?? 0), 0);
    state.dailyReservedMicrousd = [...jobs.values()].reduce((sum, j) => sum + (j.actual_microusd === null ? j.reservation_microusd : 0), 0);
    state.dailyCalls = [...jobs.values()].filter(j => j.reservation_microusd > 0).length;
    state.lifetimeSpentMicrousd = state.dailySpentMicrousd;
    state.lifetimeReservedMicrousd = state.dailyReservedMicrousd;
  }
  const store = {
    getState: async () => { if (hooks.stateError) throw hooks.stateError; totals(); return { ...state }; },
    configure: async (patch: Partial<DiscordAutoState>) => { Object.assign(state, patch); return { ...state }; },
    acquireRun: async () => {
      if (active || (state.backoffUntil && Date.parse(state.backoffUntil) > NOW)) return null;
      active = { leaseId: `run-${++fence}`, fence, expiresAt: new Date(NOW + 240000).toISOString() };
      for (const job of jobs.values()) if (job.status === "generating") job.status = "uncertain";
      return active;
    },
    releaseRun: async (lease: DiscordAutoLease, result = {}) => { check(lease); calls.releases.push(result); active = null; return { released: true }; },
    getCursors: async (lease: DiscordAutoLease) => { check(lease); return [...cursors.values()]; },
    advanceCursor: async (lease: DiscordAutoLease, channelId: string, messageId: string | null = null) => {
      check(lease); calls.advances.push({ channelId, messageId });
      const previous = cursors.get(channelId)?.lastMessageId ?? state.activationSnowflake!;
      const next = messageId && BigInt(messageId) > BigInt(previous) ? messageId : previous;
      cursors.set(channelId, { channelId, lastMessageId: next, lastPolledAt: new Date(NOW).toISOString() });
      return { advanced: true };
    },
    claimJob: async (lease: DiscordAutoLease, input: { messageId: string; channelId: string; userId: string; sourceHash: string }) => {
      check(lease); if (hooks.claimError) throw hooks.claimError;
      const previous = jobs.get(input.messageId);
      if (previous) return { outcome: "duplicate", job: { ...previous } };
      const job: DiscordAutoJob = { message_id: input.messageId, channel_id: input.channelId, user_id: input.userId,
        source_hash: input.sourceHash, source_created_at: new Date(NOW - 1000).toISOString(), budget_day: state.budgetDay,
        status: "generating", reason: null, generation_fence: lease.fence, reservation_microusd: 16000,
        input_tokens: null, output_tokens: null, actual_microusd: null, settled_at: null, answer: null,
        answer_expires_at: null, send_started_at: null, send_fence: null, reply_message_id: null,
        created_at: new Date(NOW).toISOString(), updated_at: new Date(NOW).toISOString() };
      jobs.set(input.messageId, job); totals();
      return { outcome: "claimed", job: { ...job } };
    },
    completeGeneration: async (lease: DiscordAutoLease, messageId: string, result: AutoGeneration) => {
      check(lease); if (hooks.settleError) throw hooks.settleError;
      const job = jobs.get(messageId)!;
      Object.assign(job, { answer: result.answer, input_tokens: result.inputTokens, output_tokens: result.outputTokens,
        actual_microusd: result.inputTokens + 5 * result.outputTokens, settled_at: new Date(NOW).toISOString(),
        status: result.answer ? "generated" : "skipped", answer_expires_at: result.answer ? new Date(NOW + 86400000).toISOString() : null });
      totals(); return { ...job };
    },
    beginSend: async (lease: DiscordAutoLease, messageId: string) => {
      check(lease); hooks.onBeginSend?.(); if (hooks.beginSendError) throw hooks.beginSendError;
      if (!state.effectiveEnabled) return { outcome: "disabled" };
      const job = jobs.get(messageId)!;
      if (job.status !== "generated") return { outcome: "not_generated" };
      Object.assign(job, { status: "sending", send_started_at: new Date(NOW).toISOString(), send_fence: lease.fence });
      return { outcome: "sending", job: { ...job } };
    },
    markSent: async (lease: DiscordAutoLease, messageId: string, replyId: string) => {
      check(lease); if (hooks.markSentError) throw hooks.markSentError;
      const job = jobs.get(messageId)!; Object.assign(job, { status: "sent", reply_message_id: replyId, answer: null, answer_expires_at: null });
      return { ...job };
    },
    reconcileSent: async (lease: DiscordAutoLease, messageId: string, replyId: string) => {
      check(lease); const job = jobs.get(messageId)!;
      Object.assign(job, { status: "sent", reply_message_id: replyId, answer: null, answer_expires_at: null }); return { ...job };
    },
    markUncertain: async (lease: DiscordAutoLease, messageId: string, reason: string) => {
      check(lease); const job = jobs.get(messageId)!;
      Object.assign(job, { status: "uncertain", reason, answer: null, answer_expires_at: null }); totals(); return { ...job };
    },
    skipJob: async (lease: DiscordAutoLease, messageId: string, reason: string) => {
      check(lease); const job = jobs.get(messageId)!;
      Object.assign(job, { status: "skipped", reason, answer: null, answer_expires_at: null }); totals(); return { ...job };
    },
    rejectSend: async (lease: DiscordAutoLease, messageId: string, reason: string) => {
      check(lease); const job = jobs.get(messageId)!;
      if (job.status !== "sending" || job.send_fence !== lease.fence) throw new Error("invalid_send_rejection");
      Object.assign(job, { status: "generated", reason, send_started_at: null, send_fence: null }); return { ...job };
    },
    listPending: async (lease: DiscordAutoLease) => { check(lease); return [...jobs.values()].filter(j => ["generated", "sending", "uncertain"].includes(j.status) && (j.status === "generated" || j.send_started_at)).map(j => ({ ...j })); },
  } as DiscordAutoStore;
  const transport = {
    health: async () => ({ botId: BOT, applicationId: BOT, applicationFlags: "0", messageContentEnabled: true,
      messageContentLimited: true, messageContentApproved: false, approximateGuildCount: 1, interactionsEndpointUrl: null }),
    discoverChannels: async () => ({ botId: BOT, channels, skipped: [] }),
    fetchAfter: async (channelId: string, after: string) => {
      calls.polls.push(channelId);
      const items = (batches.get(channelId) ?? []).filter(m => hooks.replayBatches || BigInt(m.id) > BigInt(after));
      return { messages: items, complete: !incomplete.has(channelId), nextBefore: null, highWaterId: items.at(-1)?.id ?? null };
    },
    fetchMessages: async (channelId: string) => {
      const items = recent.get(channelId) ?? [];
      return { messages: items, full: false, oldestId: items[0]?.id ?? null, newestId: items.at(-1)?.id ?? null };
    },
    fetchMessage: async (_channelId: string, messageId: string) => {
      if (hooks.sourceError) throw hooks.sourceError;
      const source = sources.get(messageId); if (!source) throw new DiscordTransportError("not_found", "Deleted source");
      return source;
    },
    replyToMessage: async (input: { channelId: string; messageId: string; content: string }) => {
      calls.send.push(input); if (hooks.sendError) throw hooks.sendError;
      return message(input.channelId, input.content, { authorId: BOT, authorBot: true, referencedMessageId: input.messageId });
    },
  } as Pick<DiscordAutoTransport, "health" | "discoverChannels" | "fetchAfter" | "fetchMessages" | "fetchMessage" | "replyToMessage">;
  const generate = async (question: string, context: string[]): Promise<AutoGeneration> => {
    calls.generate.push({ question, context }); hooks.onGenerate?.(); if (hooks.generateError) throw hooks.generateError;
    return { answer: "Ask about a recent real experience and listen for the current workaround.", inputTokens: 100, outputTokens: 20 };
  };
  function add(...items: DiscordMessage[]) {
    for (const item of items) {
      batches.set(item.channelId, [...(batches.get(item.channelId) ?? []), item]); sources.set(item.id, item);
    }
  }
  const run = () => runDiscordAutoQuestions({ store, transport, guildId: GUILD, applicationId: BOT, generate, now: () => NOW });
  return { state, jobs, cursors, batches, sources, recent, incomplete, calls, hooks, store, transport, add, run, channels };
}

test("repeated and simultaneous polls generate and send each source at most once", async () => {
  const h = harness(); const question = message(h.channels[0].id); h.add(question); h.hooks.replayBatches = true;
  const reports = await Promise.all([h.run(), h.run()]);
  assert.ok(reports.some(r => r.status === "busy_or_backoff"));
  await h.run();
  assert.equal(h.calls.generate.length, 1); assert.equal(h.calls.send.length, 1);
  assert.equal(h.jobs.get(question.id)?.status, "sent");
  assert.equal(h.state.dailySpentMicrousd, 200);
});

test("interrupted generation retains its worst-case reservation and never regenerates", async () => {
  const h = harness(); const question = message(h.channels[0].id); h.add(question);
  h.hooks.generateError = new Error("AbortError");
  assert.equal((await h.run()).status, "state_or_model_failure");
  h.hooks.generateError = null; await h.run();
  assert.equal(h.calls.generate.length, 1); assert.equal(h.calls.send.length, 0);
  assert.equal(h.jobs.get(question.id)?.status, "uncertain");
  assert.equal(h.state.dailyReservedMicrousd, 16000); assert.equal(h.state.dailySpentMicrousd, 0);
});

test("unknown settlement failure retains reservation, preventing another paid generation", async () => {
  const h = harness(); const question = message(h.channels[0].id); h.add(question);
  h.hooks.settleError = new Error("database_unavailable"); await h.run();
  h.hooks.settleError = null; await h.run();
  assert.equal(h.calls.generate.length, 1); assert.equal(h.calls.send.length, 0);
  assert.equal(h.state.dailyReservedMicrousd, 16000); assert.equal(h.jobs.get(question.id)?.status, "uncertain");
});

test("ambiguous Discord delivery never regenerates or retries the POST and keeps actual spend", async () => {
  const h = harness(); const question = message(h.channels[0].id); h.add(question);
  h.hooks.sendError = new DiscordTransportError("timeout", "Response lost"); await h.run();
  h.hooks.sendError = null; await h.run();
  assert.equal(h.calls.generate.length, 1); assert.equal(h.calls.send.length, 1);
  assert.equal(h.jobs.get(question.id)?.status, "uncertain"); assert.equal(h.jobs.get(question.id)?.answer, null);
  assert.equal(h.state.dailySpentMicrousd, 200); assert.equal(h.state.dailyReservedMicrousd, 0);
});

test("markSent database failure after a successful Discord POST is uncertain, never requeued", async () => {
  const h = harness(); const question = message(h.channels[0].id); h.add(question);
  h.hooks.markSentError = new Error("database_unavailable"); await h.run();
  h.hooks.markSentError = null; await h.run();
  assert.equal(h.calls.generate.length, 1); assert.equal(h.calls.send.length, 1);
  assert.equal(h.jobs.get(question.id)?.status, "uncertain"); assert.equal(h.state.dailySpentMicrousd, 200);
});

for (const kind of ["rate_limit", "budget"] as const) {
  test(`a ${kind}-shaped markSent failure cannot requeue an already accepted POST`, async () => {
    const h = harness(); const question = message(h.channels[0].id); h.add(question);
    h.hooks.markSentError = new DiscordTransportError(kind, "Failure after the Discord response");
    await h.run(); h.hooks.markSentError = null; await h.run();
    assert.equal(h.calls.send.length, 1); assert.equal(h.calls.generate.length, 1);
    assert.equal(h.jobs.get(question.id)?.status, "uncertain");
    assert.equal(h.state.dailySpentMicrousd, 200);
  });
}

for (const kind of ["rate_limit", "budget"] as const) {
  test(`provably rejected ${kind} send retries the saved answer without another generation`, async () => {
    const h = harness(); const question = message(h.channels[0].id); h.add(question);
    h.hooks.sendError = new DiscordTransportError(kind, "Request not accepted", { retryAfterMs: kind === "rate_limit" ? 120000 : undefined });
    await h.run();
    assert.equal(h.jobs.get(question.id)?.status, "generated");
    assert.ok(h.jobs.get(question.id)?.answer); assert.equal(h.jobs.get(question.id)?.send_started_at, null);
    assert.equal(h.state.dailySpentMicrousd, 200);
    h.hooks.sendError = null; await h.run();
    assert.equal(h.calls.generate.length, 1); assert.equal(h.calls.send.length, 2);
    assert.equal(h.jobs.get(question.id)?.status, "sent");
    if (kind === "rate_limit") assert.equal((h.calls.releases[0] as { retryAfterMs: number }).retryAfterMs, 120000);
  });
}

test("existing bot reply is reconciled after uncertainty without any second POST", async () => {
  const h = harness(); const question = message(h.channels[0].id); h.add(question);
  h.hooks.sendError = new DiscordTransportError("network", "Response lost"); await h.run();
  h.hooks.sendError = null;
  const existing = message(question.channelId, "Existing answer", { authorId: BOT, authorBot: true, referencedMessageId: question.id });
  h.recent.set(question.channelId, [existing]);
  assert.equal((await h.run()).reconciled, 1);
  assert.equal(h.jobs.get(question.id)?.reply_message_id, existing.id);
  assert.equal(h.calls.generate.length, 1); assert.equal(h.calls.send.length, 1);
});

for (const change of ["edited", "deleted", "stale"] as const) {
  test(`${change} source cancels generated answer and preserves model spend`, async () => {
    const h = harness(); const question = message(h.channels[0].id); h.add(question);
    h.hooks.onGenerate = () => {
      if (change === "deleted") h.sources.delete(question.id);
      else h.sources.set(question.id, { ...question, ...(change === "edited" ? { content: "Different personal details now" } : { createdAt: new Date(NOW - 660000).toISOString() }) });
    };
    await h.run();
    assert.equal(h.calls.generate.length, 1); assert.equal(h.calls.send.length, 0);
    assert.equal(h.jobs.get(question.id)?.status, "skipped"); assert.equal(h.jobs.get(question.id)?.answer, null);
    assert.equal(h.state.dailySpentMicrousd, 200);
  });
}

test("database failure before claim cannot start generation or delivery", async () => {
  const h = harness(); h.add(message(h.channels[0].id)); h.hooks.claimError = new Error("unavailable");
  assert.equal((await h.run()).status, "state_or_model_failure");
  assert.equal(h.calls.generate.length, 0); assert.equal(h.calls.send.length, 0); assert.equal(h.jobs.size, 0);
  h.hooks.stateError = new Error("unavailable"); await h.run();
  assert.equal(h.calls.generate.length, 0); assert.equal(h.calls.send.length, 0);
});

test("database failure at the final send gate prevents a POST", async () => {
  const h = harness(); h.add(message(h.channels[0].id)); h.hooks.beginSendError = new Error("unavailable");
  await h.run(); assert.equal(h.calls.send.length, 0); assert.equal(h.state.dailySpentMicrousd, 200);
  assert.equal([...h.jobs.values()][0].status, "generated");
});

for (const point of ["after_generation", "at_send_gate"] as const) {
  test(`kill switch flipped ${point} prevents delivery`, async () => {
    const h = harness(); h.add(message(h.channels[0].id));
    const kill = () => { h.state.enabled = false; h.state.effectiveEnabled = false; };
    if (point === "after_generation") h.hooks.onGenerate = kill; else h.hooks.onBeginSend = kill;
    await h.run(); assert.equal(h.calls.generate.length, 1); assert.equal(h.calls.send.length, 0);
    assert.equal(h.state.dailySpentMicrousd, 200);
  });
}

test("exclusions propagate through text parents, forum parents and category metadata", async () => {
  const category = "100000000000000100", forum = "100000000000000101", text = "100000000000000102";
  const channels = [channel(text, { parentId: category, categoryId: category }),
    channel("100000000000000103", { type: 11, kind: "thread", parentId: text, categoryId: category }),
    channel("100000000000000104", { type: 11, kind: "thread", parentId: forum, categoryId: category })];
  for (const c of channels) assert.equal(isExcludedDiscordChannel(c.id, [category], channels), true);
  assert.equal(isExcludedDiscordChannel(channels[2].id, [forum], channels), true);
  assert.equal(isExcludedDiscordChannel(channels[1].id, [text], channels), true);
  const h = harness(channels); h.state.excludedChannelIds = [category];
  channels.forEach(c => h.add(message(c.id)));
  await h.run(); assert.equal(h.calls.polls.length, 0); assert.equal(h.calls.generate.length, 0);
});

test("an exclusion changed during polling is rechecked before a paid model claim", async () => {
  const category = "100000000000000100";
  const h = harness([channel("100000000000000010", { categoryId: category })]);
  h.add(message(h.channels[0].id));
  const fetchAfter = h.transport.fetchAfter;
  h.transport.fetchAfter = async (...args) => {
    const result = await fetchAfter(...args);
    h.state.excludedChannelIds = [category];
    return result;
  };
  await h.run();
  assert.equal(h.calls.generate.length, 0); assert.equal(h.calls.send.length, 0); assert.equal(h.jobs.size, 0);
});

test("context includes only the same channel and excludes webhooks and other bots", async () => {
  const h = harness(); const c = h.channels[0].id;
  const human = message(c, "I tried asking about last week's event.");
  const foreign = message("100000000000000055", "Private context from another channel");
  const bot = message(c, "Ask about a recent real event.", { authorBot: true, authorId: BOT });
  const question = message(c);
  h.batches.set(c, [human, foreign, bot, question]); h.sources.set(question.id, question);
  await h.run();
  assert.deepEqual(h.calls.generate[0].context, [`Channel member: ${human.content}`, `Batch0 AI: ${bot.content}`]);
  assert.ok(h.calls.generate.every(g => g.context.every(line => !line.includes("Private context"))));
  const h2 = harness(); const second = message(c);
  h2.add(message(c, "Other automation", { authorBot: true, authorId: "100000000000000088" }),
    message(c, "Webhook automation", { webhookId: "100000000000000089" }), second);
  await h2.run(); assert.deepEqual(h2.calls.generate[0].context, []);
});

test("a human's explicit reply suppresses an automatic answer", async () => {
  const h = harness(); const question = message(h.channels[0].id);
  h.add(question, message(question.channelId, "Use the workbook in your course dashboard.", { referencedMessageId: question.id, authorId: "100000000000000004" }));
  await h.run(); assert.equal(h.calls.generate.length, 0); assert.equal(h.calls.send.length, 0);
});

test("incomplete pagination records a poll without jumping the durable message cursor", async () => {
  const h = harness(); const question = message(h.channels[0].id); h.add(question); h.incomplete.add(question.channelId);
  const previous = h.state.activationSnowflake!;
  h.cursors.set(question.channelId, { channelId: question.channelId, lastMessageId: previous, lastPolledAt: new Date(NOW - 60000).toISOString() });
  const report = await h.run();
  assert.equal(report.backlog, 1); assert.equal(report.status, "backlog");
  assert.equal(h.cursors.get(question.channelId)?.lastMessageId, previous);
  assert.equal(h.calls.generate.length, 0);
});

test("guilds with more than thirty channels rotate to channels not polled last run", async () => {
  const channels = Array.from({ length: 35 }, (_, index) => channel(String(BigInt("100000000000000010") + BigInt(index))));
  const h = harness(channels);
  await h.run(); assert.equal(h.calls.polls.length, 30);
  const unpolled = channels.map(c => c.id).filter(channelId => !h.calls.polls.includes(channelId));
  await h.run();
  assert.deepEqual(new Set(h.calls.polls.slice(30, 35)), new Set(unpolled));
  assert.equal(new Set(h.calls.polls).size, 35);
});

test("stored source fingerprint changes with content/channel/author and excludes mutable delivery metadata", () => {
  const source = message(channel().id);
  assert.notEqual(discordSourceHash(source), discordSourceHash({ ...source, content: "Changed" }));
  assert.notEqual(discordSourceHash(source), discordSourceHash({ ...source, channelId: "100000000000000099" }));
  assert.notEqual(discordSourceHash(source), discordSourceHash({ ...source, authorId: "100000000000000099" }));
  assert.equal(discordSourceHash(source), discordSourceHash({ ...source, referencedMessageId: "100000000000000099" }));
});
