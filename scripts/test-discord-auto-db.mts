/** Isolated PostgreSQL integration tests; NEVER connects to linked Supabase.
 * Run: node --test scripts/test-discord-auto-db.mts
 * Requires @electric-sql/pglite (dev dependency), or set BATCH0_PGLITE_MODULE to
 * an absolute installed module path. PGlite executes the actual migration and
 * PL/pgSQL. It serializes connections; production multi-session lock contention
 * still merits staging verification, while constraints/ACLs/transitions run here.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, beforeEach, test } from "node:test";
import { pathToFileURL } from "node:url";
import { createDiscordAutoStore, type DiscordAutoLease } from "../lib/discord-auto-store.ts";

const packagePath = process.env.BATCH0_PGLITE_MODULE;
const moduleName = packagePath ? pathToFileURL(packagePath).href : "@electric-sql/pglite";
const { PGlite } = await import(moduleName);
const db = new PGlite();
await db.exec(`
  create role anon; create role authenticated; create role service_role;
  create table public.site_settings(key text primary key,value jsonb);
  insert into public.site_settings values ('discord_enabled','true'::jsonb);
`);
await db.exec(await readFile(new URL("../supabase/migrations/0067_discord_auto_questions.sql", import.meta.url), "utf8"));

// The real adapter executes against real PL/pgSQL with service_role privileges.
const client = {
  rpc: async (name: string, args?: Record<string, unknown>) => {
    await db.exec("set role service_role");
    try {
      const result = name === "discord_auto_state"
        ? await db.query("select public.discord_auto_state() as result")
        : await db.query("select public.discord_auto_transition($1,$2::jsonb) as result", [args?.p_action, JSON.stringify(args?.p_input)]);
      return { data: result.rows[0].result, error: null };
    } catch (err) {
      return { data: null, error: err };
    } finally {
      await db.exec("reset role");
    }
  },
};
const store = createDiscordAutoStore(client as unknown as Parameters<typeof createDiscordAutoStore>[0]);
let serial = 0;
const sourceHash = "a".repeat(64);
function messageId(time = Date.now() + 2000) {
  return ((BigInt(time) - BigInt(1420070400000)) * BigInt(4194304) + BigInt(++serial)).toString();
}
function candidate(channelId = String(++serial), userId = String(++serial), id = messageId()) {
  return { messageId: id, channelId, userId, sourceHash };
}
async function start() {
  await store.configure({ enabled: true });
  const lease = await store.acquireRun();
  assert.ok(lease);
  return lease;
}
async function generated(lease: DiscordAutoLease) {
  const job = candidate();
  assert.equal((await store.claimJob(lease, job)).outcome, "claimed");
  await store.completeGeneration(lease, job.messageId, { answer: "Read the first course lesson and write five observations.", inputTokens: 100, outputTokens: 20 });
  return job;
}
beforeEach(async () => {
  await db.exec(`truncate public.discord_auto_jobs,public.discord_auto_cursors;
    delete from public.discord_auto_config; insert into public.discord_auto_config(id) values(true);
    delete from public.site_settings; insert into public.site_settings values('discord_enabled','true'::jsonb);`);
});
after(async () => { await db.close(); });

test("disabled conservative defaults and fail-closed master setting", async () => {
  const initial = await store.getState();
  assert.equal(initial.enabled, false);
  assert.equal(initial.effectiveEnabled, false);
  assert.equal(initial.dailyBudgetMicrousd, 250000);
  assert.equal(initial.lifetimeBudgetMicrousd, 5000000);
  assert.equal(initial.maxRepliesPerDay, 100);
  assert.equal(initial.userCooldownSeconds, 60);
  assert.equal(initial.channelCooldownSeconds, 60);
  assert.equal(initial.activationAt, null);
  await store.configure({ enabled: true });
  await db.exec("delete from public.site_settings");
  assert.equal((await store.getState()).effectiveEnabled, false);
  const lease = await store.acquireRun(); assert.ok(lease);
  assert.equal((await store.claimJob(lease, candidate())).outcome, "disabled");
});

test("anonymous/authenticated roles cannot read state or execute any RPC; service cannot bypass transitions", async () => {
  for (const role of ["anon", "authenticated"]) {
    await db.exec(`set role ${role}`);
    try {
      for (const table of ["config", "jobs", "cursors"]) {
        await assert.rejects(db.query(`select * from public.discord_auto_${table}`), { code: "42501" });
      }
      await assert.rejects(db.query("select public.discord_auto_state()"), { code: "42501" });
      await assert.rejects(db.query("select public.discord_auto_transition('acquire_run','{}')"), { code: "42501" });
    } finally { await db.exec("reset role"); }
  }
  await db.exec("set role service_role");
  try {
    await assert.rejects(db.query("update public.discord_auto_config set enabled=true"), { code: "42501" });
    await assert.rejects(db.query("delete from public.discord_auto_jobs"), { code: "42501" });
    await assert.rejects(db.query("insert into public.discord_auto_cursors values('1','2',now(),1,now())"), { code: "42501" });
  } finally { await db.exec("reset role"); }
  const functions = await db.query("select prosecdef,proconfig from pg_proc where proname in ('discord_auto_state','discord_auto_transition')");
  assert.equal(functions.rows.length, 2);
  for (const fn of functions.rows) {
    assert.equal(fn.prosecdef, true);
    assert.ok(fn.proconfig.some((s: string) => s.startsWith("search_path=")));
  }
});

test("source IDs deduplicate permanently and reservations/day/cost are database-owned", async () => {
  const lease = await start(); const job = candidate();
  const claim = await store.claimJob(lease, job);
  assert.equal(claim.outcome, "claimed");
  assert.equal(claim.job.reservation_microusd, 16000);
  assert.equal(claim.job.source_hash, sourceHash);
  assert.equal(claim.job.budget_day, new Date().toISOString().slice(0, 10));
  assert.equal((await store.claimJob(lease, job)).outcome, "duplicate");
  const result = await client.rpc("discord_auto_transition", { p_action: "claim_job", p_input: {
    ...lease, ...candidate(), reservationMicrousd: 1, actualMicrousd: 0, budgetDay: "2099-01-01",
  } });
  assert.equal(result.error, null);
  assert.equal(result.data.job.reservation_microusd, 16000);
  assert.equal(result.data.job.budget_day, new Date().toISOString().slice(0, 10));
  const state = await store.getState();
  assert.equal(state.dailyCalls, 2); assert.equal(state.dailyReservedMicrousd, 32000);
});

test("fixed reservation prevents daily/lifetime overrun without refunding ambiguous calls", async () => {
  const lease = await start();
  await store.configure({ dailyBudgetMicrousd: 32000, lifetimeBudgetMicrousd: 48000 });
  const first = candidate(), second = candidate();
  assert.equal((await store.claimJob(lease, first)).outcome, "claimed");
  assert.equal((await store.claimJob(lease, second)).outcome, "claimed");
  assert.equal((await store.claimJob(lease, candidate())).outcome, "budget");
  await store.markUncertain(lease, first.messageId, "provider_timeout");
  assert.equal((await store.getState()).dailyReservedMicrousd, 32000);
  await store.configure({ dailyBudgetMicrousd: 1000000 });
  assert.equal((await store.claimJob(lease, candidate())).outcome, "claimed");
  assert.equal((await store.claimJob(lease, candidate())).outcome, "budget");
  assert.equal((await store.getState()).lifetimeReservedMicrousd, 48000);
});

test("actual usage settles idempotently and cannot be changed or exceed model limits", async () => {
  const lease = await start(); const job = candidate(); await store.claimJob(lease, job);
  const result = { answer: "Use evidence from a recent real interview.", inputTokens: 12000, outputTokens: 700 };
  assert.equal((await store.completeGeneration(lease, job.messageId, result)).actual_microusd, 15500);
  await store.completeGeneration(lease, job.messageId, result);
  const state = await store.getState();
  assert.equal(state.dailySpentMicrousd, 15500); assert.equal(state.dailyReservedMicrousd, 0);
  await assert.rejects(store.completeGeneration(lease, job.messageId, { ...result, inputTokens: 11999 }));
  const other = candidate(); await store.claimJob(lease, other);
  await assert.rejects(store.completeGeneration(lease, other.messageId, { ...result, inputTokens: 12001 }));
  await assert.rejects(store.completeGeneration(lease, other.messageId, { ...result, outputTokens: 701 }));
  assert.equal((await store.getState()).dailyReservedMicrousd, 16000);
});

test("classifier declines and known uncalled preflight settle with no answer", async () => {
  const lease = await start(); const job = candidate(); await store.claimJob(lease, job);
  const result = await store.completeGeneration(lease, job.messageId, { answer: null, inputTokens: 50, outputTokens: 7 });
  assert.equal(result.status, "skipped"); assert.equal(result.reason, "no_answer");
  assert.equal(result.actual_microusd, 85); assert.equal(result.answer, null);
  const preflight = candidate(); await store.claimJob(lease, preflight);
  await store.completeGeneration(lease, preflight.messageId, { answer: null, inputTokens: 0, outputTokens: 0 });
  const state = await store.getState();
  assert.equal(state.dailySpentMicrousd, 85); assert.equal(state.dailyReservedMicrousd, 0);
  assert.equal(state.dailyCalls, 2);
});

test("only one lease exists; expired worker is fenced from writes, send and settlement", async () => {
  const lease = await start(); const job = candidate(); await store.claimJob(lease, job);
  const ready = await generated(lease);
  assert.equal(await store.acquireRun(), null);
  await db.exec("update public.discord_auto_config set lease_expires_at=now()-interval '1 second'");
  const next = await store.acquireRun(); assert.ok(next);
  assert.ok(next.fence > lease.fence); assert.notEqual(next.leaseId, lease.leaseId);
  await assert.rejects(store.advanceCursor(lease, "123", messageId()));
  await assert.rejects(store.beginSend(lease, ready.messageId));
  await assert.rejects(store.completeGeneration(lease, job.messageId, { answer: "Late response", inputTokens: 50, outputTokens: 7 }));
  assert.equal((await store.claimJob(next, job)).job.status, "uncertain");
  assert.equal((await store.getState()).dailyReservedMicrousd, 16000);
  assert.equal((await store.beginSend(next, ready.messageId)).outcome, "sending");
});

test("killing the feature/master/excluding channel prevents reserved delivery", async () => {
  const lease = await start(); const ready = await generated(lease);
  await store.configure({ enabled: false });
  assert.equal((await store.beginSend(lease, ready.messageId)).outcome, "disabled");
  await store.configure({ enabled: true });
  const ready2 = await generated(lease);
  await db.exec("update public.site_settings set value='false'::jsonb");
  assert.equal((await store.beginSend(lease, ready2.messageId)).outcome, "disabled");
  await db.exec("update public.site_settings set value='true'::jsonb");
  await store.configure({ excludedChannelIds: [ready2.channelId] });
  assert.equal((await store.beginSend(lease, ready2.messageId)).outcome, "ineligible");
  assert.equal((await store.claimJob(lease, candidate(ready2.channelId))).outcome, "excluded");
});

test("sending transitions once; ambiguous send can only reconcile an existing reply", async () => {
  const lease = await start(); const ready = await generated(lease);
  assert.equal((await store.beginSend(lease, ready.messageId)).outcome, "sending");
  assert.equal((await store.beginSend(lease, ready.messageId)).outcome, "not_generated");
  await store.markUncertain(lease, ready.messageId, "discord_timeout");
  assert.equal((await store.beginSend(lease, ready.messageId)).outcome, "not_generated");
  await store.releaseRun(lease);
  const next = await store.acquireRun(); assert.ok(next);
  await assert.rejects(store.markSent(next, ready.messageId, "4321"));
  const sent = await store.reconcileSent(next, ready.messageId, "4321");
  assert.equal(sent.status, "sent"); assert.equal(sent.answer, null); assert.equal(sent.answer_expires_at, null);
  assert.equal((await store.reconcileSent(next, ready.messageId, "4321")).status, "sent");
  await assert.rejects(store.reconcileSent(next, ready.messageId, "4322"));
  assert.equal((await store.claimJob(next, ready)).outcome, "duplicate");
});

test("unattempted generated reply cannot be marked sent; edited-source cancellation erases answer", async () => {
  const lease = await start(); const ready = await generated(lease);
  await assert.rejects(store.reconcileSent(lease, ready.messageId, "999"));
  const skipped = await store.skipJob(lease, ready.messageId, "source_changed");
  assert.equal(skipped.status, "skipped"); assert.equal(skipped.answer, null);
  assert.equal(skipped.actual_microusd, 200);
  assert.equal((await store.beginSend(lease, ready.messageId)).outcome, "not_generated");
});

test("known rejected sends retry without regeneration, cost refund, or expiry extension", async () => {
  const lease = await start();
  const ready = await generated(lease);
  for (const reason of ["rate_limit", "request_budget"] as const) {
    const sending = await store.beginSend(lease, ready.messageId);
    assert.equal(sending.outcome, "sending");
    assert.ok(sending.outcome === "sending");
    const restored = await store.rejectSend(lease, ready.messageId, reason);
    assert.equal(restored.status, "generated"); assert.equal(restored.reason, reason);
    assert.equal(restored.answer, sending.job.answer);
    assert.equal(restored.answer_expires_at, sending.job.answer_expires_at);
    assert.equal(restored.actual_microusd, 200); assert.equal(restored.reservation_microusd, 16000);
    assert.equal(restored.send_started_at, null); assert.equal(restored.send_fence, null);
    assert.equal((await store.getState()).dailySpentMicrousd, 200);
    assert.equal((await store.getState()).dailyCalls, 1);
    await assert.rejects(store.rejectSend(lease, ready.messageId, reason));
  }
  assert.equal((await store.beginSend(lease, ready.messageId)).outcome, "sending");
  assert.equal((await store.markSent(lease, ready.messageId, "4321")).status, "sent");
  await assert.rejects(store.rejectSend(lease, ready.messageId, "rate_limit"));
});

test("send rejection is strict, same-fence only, and cannot revive an ambiguous attempt", async () => {
  const lease = await start(); const ready = await generated(lease);
  await store.beginSend(lease, ready.messageId);
  for (const reason of [null, "timeout", "network", "api", "mark_sent_failed"]) {
    const bad = await client.rpc("discord_auto_transition", {p_action: "send_rejected", p_input: {...lease, messageId: ready.messageId, reason}});
    assert.ok(bad.error);
  }
  await db.exec("update public.discord_auto_config set lease_expires_at=now()-interval '1 second'");
  const next = await store.acquireRun(); assert.ok(next);
  await assert.rejects(store.rejectSend(lease, ready.messageId, "rate_limit"));
  await assert.rejects(store.rejectSend(next, ready.messageId, "rate_limit"));
  await store.markUncertain(next, ready.messageId, "delivery_uncertain");
  await assert.rejects(store.rejectSend(next, ready.messageId, "request_budget"));
  assert.equal((await store.beginSend(next, ready.messageId)).outcome, "not_generated");
});

test("expired answers are erased; old ambiguous sends cannot crowd out generated replies", async () => {
  const lease = await start(); const stale = await generated(lease);
  const ambiguous = await generated(lease);
  await store.beginSend(lease, ambiguous.messageId);
  await store.markUncertain(lease, ambiguous.messageId, "discord_timeout");
  await db.query("update public.discord_auto_jobs set answer_expires_at=now()-interval '1 second' where message_id=$1", [stale.messageId]);
  await db.query("update public.discord_auto_jobs set send_started_at=now()-interval '2 days' where message_id=$1", [ambiguous.messageId]);
  const fresh = await generated(lease);
  await store.releaseRun(lease);
  const next = await store.acquireRun(); assert.ok(next);
  const pending = await store.listPending(next);
  assert.deepEqual(pending.map(j => j.message_id), [fresh.messageId]);
  const old = (await db.query("select status,answer from public.discord_auto_jobs where message_id=$1", [stale.messageId])).rows[0];
  assert.equal(old.status, "uncertain"); assert.equal(old.answer, null);
});

test("activation rejects old history; disable/enable advances boundary without resetting costs", async () => {
  const lease = await start();
  const old = candidate(undefined, undefined, messageId(Date.now() - 10000));
  assert.equal((await store.claimJob(lease, old)).outcome, "before_activation");
  await generated(lease);
  const first = await store.getState();
  await store.configure({ enabled: false }); await store.configure({ enabled: true });
  const next = await store.getState();
  assert.ok(Date.parse(next.activationAt!) >= Date.parse(first.activationAt!));
  assert.equal(next.lifetimeSpentMicrousd, 200); assert.equal(next.dailyCalls, 1);
  await assert.rejects(store.configure({ lifetimeBudgetMicrousd: 5000001 }));
  await assert.rejects(store.configure({ dailyBudgetMicrousd: 1000001 }));
  await assert.rejects(store.configure({ userCooldownSeconds: 0 }));
  const bad = await client.rpc("discord_auto_transition", { p_action: "configure", p_input: { activationAt: "2000-01-01" } });
  assert.ok(bad.error);
});

test("user/channel cooldowns and daily calls limit apply to reserved calls", async () => {
  const lease = await start(); await store.configure({ maxRepliesPerDay: 2 });
  assert.equal((await store.claimJob(lease, candidate("12", "34"))).outcome, "claimed");
  assert.equal((await store.claimJob(lease, candidate("12", "35"))).outcome, "cooldown");
  assert.equal((await store.claimJob(lease, candidate("13", "34"))).outcome, "cooldown");
  assert.equal((await store.claimJob(lease, candidate("13", "35"))).outcome, "claimed");
  assert.equal((await store.claimJob(lease, candidate("14", "36"))).outcome, "daily_limit");
  assert.equal((await store.getState()).dailyCalls, 2);
});

test("durable cursors are monotonic, empty polls recorded, stale leases rejected", async () => {
  const lease = await start(); const state = await store.getState();
  await store.advanceCursor(lease, "1");
  const empty = (await store.getCursors(lease))[0];
  assert.equal(empty.lastMessageId, state.activationSnowflake);
  assert.ok(empty.lastPolledAt);
  const high = messageId(); await store.advanceCursor(lease, "1", high);
  await store.advanceCursor(lease, "1", state.activationSnowflake);
  assert.equal((await store.getCursors(lease))[0].lastMessageId, high);
  await store.releaseRun(lease);
  await assert.rejects(store.advanceCursor(lease, "1", messageId()));
});

test("global rate-limit backoff survives runs; summary cannot store source prose", async () => {
  const lease = await start();
  await store.releaseRun(lease, { error: "discord_rate_limited", summary: { processed: 3, answered: 1, status: "rate_limited" }, retryAfterMs: 120000 });
  const state = await store.getState();
  assert.equal(state.lastError, "discord_rate_limited");
  assert.equal(state.lastRunSummary.processed, 3); assert.ok(state.backoffUntil);
  assert.equal(await store.acquireRun(), null);
  await db.exec("update public.discord_auto_config set backoff_until=now()-interval '1 second'");
  const next = await store.acquireRun(); assert.ok(next);
  await assert.rejects(store.releaseRun(next, { summary: { question: "A private student question" } }));
  await assert.rejects(store.releaseRun(next, { retryAfterMs: 86400001 }));
  await store.releaseRun(next, { summary: { ok: true } });
});

test("failed RPCs remain fail-closed and hide raw provider/database payloads", async () => {
  const broken = createDiscordAutoStore({ rpc: async () => ({ data: null, error: { code: "XX000", message: "secret raw source payload" } }) } as unknown as Parameters<typeof createDiscordAutoStore>[0]);
  await assert.rejects(broken.getState(), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /XX000/); assert.doesNotMatch(error.message, /secret/);
    return true;
  });
});
