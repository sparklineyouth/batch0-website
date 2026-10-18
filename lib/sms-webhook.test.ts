import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { existsSync } from "node:fs";
import * as nodeModule from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// The real webhook route (app/api/webhooks/sms/route.ts) and the real consent
// module behind it, run against an in-memory stand-in for the service-role
// client. This is the most compliance-critical route in the codebase — a STOP
// that arrives and isn't recorded is a revocation we failed to honour — so the
// things it promises are asserted end to end rather than read:
//
//   * it refuses everything until a provider auth token exists (the shipped
//     state), and refuses a bad signature after that;
//   * a STOP — or a sentence asking us to stop — is written to the ledger and
//     the suppression row before the reply, cancels what's queued, gets ONE
//     confirmation, and a failed write is a 500 so the provider retries;
//   * a STOP onto a dashboard opt-out is recorded as a STOP, so it locks;
//   * HELP always answers, START restores without widening, and anything else
//     from an opted-out number gets silence — and from anyone else, the
//     "not monitored" reply at most once a day;
//   * a token rotated in another instance doesn't 403 genuine requests;
//   * a carrier's terminal receipt fails the outbox row for good, and a
//     `queued` receipt doesn't touch it.

const SITE = "https://batch0.test";
const TOKEN = "test-auth-token";
const URL_SIGNED = `${SITE}/api/webhooks/sms`;
const PHONE = "+16095550123";

type Row = Record<string, any>;
const state: {
  settings: Row;
  /** What a cache-bypassing read sees, when it differs from the cached row. */
  freshSettings: Row | null;
  tables: Record<string, Row[]>;
  /** Table → error to return from the next insert into it. */
  failInsert: Record<string, string>;
} = { settings: {}, freshSettings: null, tables: {}, failInsert: {} };

/**
 * The PostgREST builder surface the route and lib/sms/consent.ts use, over
 * plain arrays: select/eq/in/is/maybeSingle, insert, upsert on a conflict key,
 * update with filters. Enough to watch what was written, nothing more.
 */
function from(table: string) {
  const rows = (state.tables[table] ??= []);
  const filters: ((r: Row) => boolean)[] = [];
  let op: { kind: "select" } | { kind: "insert"; row: Row } | { kind: "upsert"; row: Row; key: string } | { kind: "update"; patch: Row } = { kind: "select" };
  let single = false;
  const run = async () => {
    if (op.kind === "insert") {
      const fail = state.failInsert[table];
      if (fail) {
        delete state.failInsert[table];
        return { data: null, error: { message: fail } };
      }
      rows.push({ created_at: new Date().toISOString(), ...op.row });
      return { data: null, error: null };
    }
    if (op.kind === "upsert") {
      const { row, key } = op;
      const hit = rows.find((r) => r[key] === row[key]);
      if (hit) {
        for (const [k, v] of Object.entries(row)) if (v !== undefined) hit[k] = v;
      } else rows.push({ created_at: new Date().toISOString(), ...row });
      return { data: null, error: null };
    }
    const matched = rows.filter((r) => filters.every((f) => f(r)));
    if (op.kind === "update") {
      for (const r of matched) Object.assign(r, op.patch);
      return { data: matched, error: null };
    }
    return { data: single ? (matched[0] ?? null) : matched, error: null };
  };
  const chain: any = {
    select: () => chain,
    eq: (k: string, v: unknown) => (filters.push((r) => r[k] === v), chain),
    neq: (k: string, v: unknown) => (filters.push((r) => r[k] !== v), chain),
    gte: (k: string, v: string) => (filters.push((r) => Date.parse(r[k]) >= Date.parse(v)), chain),
    in: (k: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[k])), chain),
    is: (k: string, v: unknown) => (filters.push((r) => (r[k] ?? null) === v), chain),
    order: () => chain,
    limit: () => chain,
    maybeSingle: () => ((single = true), run()),
    insert: (row: Row) => ((op = { kind: "insert", row }), chain),
    upsert: (row: Row, o?: { onConflict?: string }) => ((op = { kind: "upsert", row, key: o?.onConflict ?? "id" }), chain),
    update: (patch: Row) => ((op = { kind: "update", patch }), chain),
    then: (ok: any, bad: any) => run().then(ok, bad),
  };
  return chain;
}
(globalThis as any).__smsWebhook = { state, from };

const root = fileURLToPath(new URL("../", import.meta.url));
const fake = (source: string) => `data:text/javascript,${encodeURIComponent(source)}`;
(nodeModule as any).registerHooks({
  resolve(specifier: string, context: any, next: any) {
    const g = "const t=globalThis.__smsWebhook;";
    const doubles: Record<string, string> = {
      "@/lib/supabase/admin": g + "export const createAdminClient=()=>({from:t.from});",
      "@/lib/env": `export const env={siteUrl:${JSON.stringify(SITE)}};`,
      "@/lib/sms/settings":
        g + "export const getSmsSettings=async(o)=>(o&&o.fresh&&t.state.freshSettings)||t.state.settings;",
      "@/lib/sms/queue": "export const MAX_ATTEMPTS=3;",
    };
    if (doubles[specifier]) return { url: fake(doubles[specifier]), shortCircuit: true };
    if (specifier.startsWith("@/")) {
      const base = path.join(root, specifier.slice(2));
      const file = existsSync(base + ".ts") ? base + ".ts" : path.join(base, "index.ts");
      return next(pathToFileURL(file).href, context);
    }
    return next(specifier, context);
  },
});
const { POST } = await import("../app/api/webhooks/sms/route.ts");
const { HELP_REPLY, OPT_IN_REPLY, OPT_OUT_REPLY, UNMONITORED_REPLY } = await import("./sms/copy.ts");

/** Twilio's scheme, written out independently of lib/sms/providers/twilio.ts. */
function sign(params: Record<string, string>, token = TOKEN): string {
  const data = URL_SIGNED + Object.keys(params).sort().map((k) => k + params[k]).join("");
  return createHmac("sha1", token).update(data, "utf8").digest("base64");
}

function post(params: Record<string, string>, signature: string | null = sign(params)) {
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
  if (signature) headers["x-twilio-signature"] = signature;
  // req.url is an internal host on purpose: the route must sign against SITE.
  return POST(new Request("http://internal.vercel/api/webhooks/sms", {
    method: "POST",
    headers,
    body: new URLSearchParams(params).toString(),
  }));
}

const inbound = (body: string, from = PHONE, sid = `SM${Math.random().toString(36).slice(2)}`) => ({
  MessageSid: sid,
  From: from,
  To: "+18005550100",
  Body: body,
});

function reset(over: { consent?: Row[]; outbox?: Row[] } = {}) {
  state.settings = { configured: true, readError: null, provider: "twilio", authToken: TOKEN };
  state.freshSettings = null;
  state.failInsert = {};
  state.tables = {
    messaging_consent: over.consent ?? [],
    messaging_consent_log: [],
    sms_outbox: over.outbox ?? [],
    sms_events: [],
  };
}

const consented = (over: Row = {}): Row => ({
  phone_e164: PHONE,
  party: "student",
  user_id: "u1",
  transactional: true,
  promotional: false,
  opted_out_at: null,
  opted_out_source: null,
  ...over,
});

const twimlOf = async (res: Response) => {
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /xml/);
  return (await res.text()).match(/<Message>(.*)<\/Message>/)?.[1]?.replace(/&amp;/g, "&");
};

// ---------------------------------------------------------------------------

test("without a provider auth token every request is refused, and nothing is read", async () => {
  reset();
  state.settings = { configured: true, readError: null, provider: "twilio", authToken: null };
  const res = await post(inbound("STOP"));
  assert.equal(res.status, 503);
  assert.deepEqual(state.tables.messaging_consent_log, []);
  assert.deepEqual(state.tables.sms_events, []);
});

test("a bad or missing signature is a 403, and nothing is written", async () => {
  reset({ consent: [consented()] });
  assert.equal((await post(inbound("STOP"), "not-the-signature")).status, 403);
  assert.equal((await post(inbound("STOP"), sign(inbound("STOP"), "wrong-token"))).status, 403);
  assert.equal((await post(inbound("STOP"), null)).status, 403);
  assert.deepEqual(state.tables.messaging_consent_log, []);
  assert.equal(state.tables.messaging_consent[0].opted_out_at, null);
});

test("STOP is recorded before the reply, cancels what's queued, and is confirmed once", async () => {
  reset({
    consent: [consented()],
    outbox: [
      { id: "o1", to_phone: PHONE, status: "pending" },
      { id: "o2", to_phone: PHONE, status: "sent" },
      { id: "o3", to_phone: "+14155550123", status: "pending" },
    ],
  });
  const reply = await twimlOf(await post(inbound("Stop.")));
  assert.equal(reply, OPT_OUT_REPLY);

  const [log] = state.tables.messaging_consent_log;
  assert.equal(log.action, "revoke");
  assert.equal(log.source, "sms_stop");
  assert.equal(log.inbound_body, "Stop.");
  const row = state.tables.messaging_consent[0];
  assert.ok(row.opted_out_at);
  assert.equal(row.opted_out_source, "sms_stop");
  assert.equal(row.transactional, true, "flags survive so START restores exactly them");
  assert.deepEqual(
    state.tables.sms_outbox.map((r) => [r.id, r.status]),
    [["o1", "canceled"], ["o2", "sent"], ["o3", "pending"]],
  );
  assert.equal(state.tables.sms_events[0].direction, "inbound");

  // A second STOP changes nothing and gets nothing back: one confirmation only.
  const again = await post(inbound("STOP"));
  assert.equal(again.status, 204);
  assert.equal(state.tables.messaging_consent_log.length, 1);
});

test("a sentence asking us to stop is honoured like STOP", async () => {
  for (const body of ["please stop texting me", "wrong number", "don’t text me anymore"]) {
    reset({ consent: [consented()], outbox: [{ id: "o1", to_phone: PHONE, status: "pending" }] });
    assert.equal(await twimlOf(await post(inbound(body))), OPT_OUT_REPLY, body);
    assert.equal(state.tables.messaging_consent_log[0]?.inbound_body, body);
    assert.ok(state.tables.messaging_consent[0].opted_out_at, body);
    assert.equal(state.tables.sms_outbox[0].status, "canceled", body);
  }
});

test("a STOP from a number we've never seen still lands as a suppression", async () => {
  reset();
  assert.equal(await twimlOf(await post(inbound("STOP", "+14155550199"))), OPT_OUT_REPLY);
  const row = state.tables.messaging_consent.find((r) => r.phone_e164 === "+14155550199");
  assert.ok(row?.opted_out_at);
  assert.equal(row?.party, "unknown");
});

test("a STOP onto a dashboard opt-out locks the number, and is confirmed by text", async () => {
  // The dashboard's own "Turn texts off" can be undone from the dashboard. A
  // STOP from the phone must not leave it that way.
  reset({
    consent: [consented({ opted_out_at: "2026-10-01T00:00:00Z", opted_out_source: "dashboard_phone", opted_out_by: "u1" })],
  });
  assert.equal(await twimlOf(await post(inbound("STOP"))), OPT_OUT_REPLY);
  const row = state.tables.messaging_consent[0];
  assert.equal(row.opted_out_source, "sms_stop");
  assert.equal(row.opted_out_by, null, "a STOP has no account");
  assert.equal(state.tables.messaging_consent_log.at(-1)?.source, "sms_stop");
  // And the next one is the no-op second STOP.
  assert.equal((await post(inbound("STOP"))).status, 204);
  assert.equal(state.tables.messaging_consent_log.length, 1);
});

test("an opt-out that can't be written is a 500, so the provider retries", async () => {
  reset({ consent: [consented()] });
  state.failInsert.messaging_consent_log = "database is down";
  const res = await post(inbound("STOP"));
  assert.equal(res.status, 500);
  assert.equal(state.tables.messaging_consent[0].opted_out_at, null);
});

test("HELP is always answered, even for an opted-out number", async () => {
  reset({ consent: [consented({ opted_out_at: "2026-10-01T00:00:00Z", opted_out_source: "sms_stop" })] });
  assert.equal(await twimlOf(await post(inbound("help"))), HELP_REPLY);
});

test("anything else gets the honest 'not monitored' reply — or silence after an opt-out", async () => {
  reset({ consent: [consented()] });
  assert.equal(await twimlOf(await post(inbound("Is the call at 6 or 7?"))), UNMONITORED_REPLY);
  reset({ consent: [consented({ opted_out_at: "2026-10-01T00:00:00Z", opted_out_source: "sms_stop" })] });
  assert.equal((await post(inbound("Is the call at 6 or 7?"))).status, 204);
});

test("the 'not monitored' reply goes out once a day, so an auto-responder can't loop with it", async () => {
  reset({ consent: [consented()] });
  assert.equal(await twimlOf(await post(inbound("ok"))), UNMONITORED_REPLY);
  // Their phone answers our reply automatically; we must not answer that.
  assert.equal((await post(inbound("I'm driving, I'll get back to you"))).status, 204);
  assert.equal((await post(inbound("ok"))).status, 204);
  // Everything is still logged.
  assert.equal(state.tables.sms_events.filter((e) => e.direction === "inbound").length, 3);

  // A day later, a new question gets the reply again.
  reset({ consent: [consented()] });
  state.tables.sms_events.push({
    event_key: "SMold:inbound",
    phone_e164: PHONE,
    direction: "inbound",
    body: "ok",
    created_at: new Date(Date.now() - 25 * 3_600_000).toISOString(),
  });
  assert.equal(await twimlOf(await post(inbound("Is the call at 6 or 7?"))), UNMONITORED_REPLY);
  // A redelivery of the same message isn't "an earlier text": Twilio only
  // redelivers when it never got our first answer.
  reset({ consent: [consented()] });
  const once = inbound("Is the call at 6 or 7?", PHONE, "SMsame");
  assert.equal(await twimlOf(await post(once)), UNMONITORED_REPLY);
  assert.equal(await twimlOf(await post(once)), UNMONITORED_REPLY);
  assert.equal(state.tables.sms_events.length, 1);
});

test("a token rotated in another instance doesn't 403 a genuine request", async () => {
  // This instance's cached settings still hold the old token; the row has the
  // new one, and Twilio is already signing with it.
  reset({ consent: [consented()] });
  state.settings = { ...state.settings, authToken: "old-token" };
  state.freshSettings = { ...state.settings, authToken: TOKEN };
  assert.equal(await twimlOf(await post(inbound("STOP"))), OPT_OUT_REPLY);
  assert.ok(state.tables.messaging_consent[0].opted_out_at);
  // A forged signature is still refused after the re-read.
  reset({ consent: [consented()] });
  state.freshSettings = { ...state.settings };
  assert.equal((await post(inbound("STOP"), sign(inbound("STOP"), "forged"))).status, 403);
});

test("START restores what the number had; from a stranger it subscribes nobody", async () => {
  reset({ consent: [consented({ opted_out_at: "2026-10-01T00:00:00Z", opted_out_source: "sms_stop" })] });
  assert.equal(await twimlOf(await post(inbound("START"))), OPT_IN_REPLY);
  const row = state.tables.messaging_consent[0];
  assert.equal(row.opted_out_at, null);
  assert.equal(row.transactional, true);
  assert.equal(row.promotional, false, "START never widens");
  assert.equal(state.tables.messaging_consent_log.at(-1)?.source, "sms_start");

  reset();
  assert.equal(await twimlOf(await post(inbound("START", "+14155550199"))), HELP_REPLY);
  assert.deepEqual(state.tables.messaging_consent, [], "one word is not consent");
});

test("a terminal carrier receipt fails the row for good; a queued receipt leaves it alone", async () => {
  reset({ outbox: [{ id: "o1", to_phone: PHONE, status: "sent", provider_id: "SM1", attempts: 1 }] });
  const queued = { MessageSid: "SM1", MessageStatus: "queued", To: PHONE };
  assert.equal((await post(queued)).status, 204);
  assert.equal(state.tables.sms_outbox[0].status, "sent", "the first receipt for a healthy message is 'queued'");

  const undelivered = { MessageSid: "SM1", MessageStatus: "undelivered", ErrorCode: "30003", To: PHONE };
  assert.equal((await post(undelivered)).status, 204);
  assert.equal(state.tables.sms_outbox[0].status, "failed");
  assert.equal(state.tables.sms_outbox[0].attempts, 3, "pushed to the cap so the retry pass leaves it");
  assert.deepEqual(
    state.tables.sms_events.map((e) => e.event_key).sort(),
    ["SM1:queued", "SM1:undelivered"],
  );
});

test("a 21610 receipt writes the suppression the carrier already has", async () => {
  reset({ consent: [consented()] });
  const res = await post({ MessageSid: "SM2", MessageStatus: "failed", ErrorCode: "21610", To: PHONE });
  assert.equal(res.status, 204);
  assert.equal(state.tables.messaging_consent[0].opted_out_source, "provider_21610");
});
