import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import * as nodeModule from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// The real drain (lib/sms/queue.ts), the real transport (lib/sms/send.ts), the
// real consent writer (lib/sms/consent.ts) and the real admin actions that
// steer them, against an in-memory stand-in for the service-role client and a
// fake provider. Everything here is a way a text used to reach a phone after
// somebody had said it shouldn't:
//
//   * "Stop this campaign" left rows a running drain had already claimed, and
//     rows waiting for a retry, to go out anyway;
//   * a quiet-hours hold wrote a cancelled row straight back to `pending`, and
//     used up an attempt it never made;
//   * pausing mid-drain stopped nothing until the batch was done;
//   * a failed test send was quietly re-sent by the retry pass;
//   * a STOP landing while an opt-in was being saved was overwritten;
//   * the webhook's failed opt-out write had nothing to fall back on;
//   * an admin's "own phone" test opt-in could put a student into campaigns;
//   * a test parked by the pause switch unlocked the campaign, and the
//     campaign action queued with no credentials at all.

const SITE = "https://batch0.test";
const P1 = "+16095550101";
const P2 = "+16095550102";
const P3 = "+16095550103";
// Noon in New Jersey, inside the 9–20 window for every 609 number.
const NOON_ET = Date.parse("2026-10-20T16:00:00Z");
// 11pm in New Jersey: outside it.
const ELEVEN_PM_ET = Date.parse("2026-10-21T03:00:00Z");

type Row = Record<string, any>;
type OpInfo = { table: string; kind: string; patch?: Row; row?: Row; matched?: Row[] };

const state: {
  settings: Row;
  tables: Record<string, Row[]>;
  sends: Row[];
  /** What the fake provider answers; may act on the world first. */
  provider: (args: Row, n: number) => Promise<Row>;
  before: ((op: OpInfo) => void) | null;
  after: ((op: OpInfo) => void) | null;
  userId: string;
  members: Row[];
} = {
  settings: {},
  tables: {},
  sends: [],
  provider: async () => ({ ok: true, providerId: "SM-x" }),
  before: null,
  after: null,
  userId: "admin-1",
  members: [],
};

// ---------------------------------------------------------------------------
// The PostgREST surface these modules use, over plain arrays
// ---------------------------------------------------------------------------

const UNIQUE: Record<string, string[]> = {
  messaging_consent: ["phone_e164"],
  sms_outbox: ["dedupe_key"],
  sms_events: ["event_key"],
  sms_campaigns: ["client_key"],
};
let seq = 0;

function compare(a: unknown, b: unknown): number {
  if (typeof a === "number" || typeof b === "number") return Number(a) - Number(b);
  return Date.parse(String(a)) - Date.parse(String(b));
}

function likeToRegex(pattern: string): RegExp {
  const body = pattern
    .split("")
    .map((c) => (c === "%" ? ".*" : c === "_" ? "." : c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("");
  return new RegExp(`^${body}$`, "i");
}

function from(table: string) {
  const rows = (state.tables[table] ??= []);
  const filters: ((r: Row) => boolean)[] = [];
  let op: { kind: "select"; head?: boolean } | { kind: "insert"; row: Row } | { kind: "upsert"; row: Row; key: string } | { kind: "update"; patch: Row } = { kind: "select" };
  let single = false;
  let order: { col: string; asc: boolean } | null = null;
  let limit = Infinity;

  const withDefaults = (row: Row): Row => {
    const now = new Date().toISOString();
    const base: Row = { created_at: now, updated_at: now };
    if (table === "sms_outbox") Object.assign(base, { id: `o${++seq}`, status: "pending", attempts: 0, send_after: now, segments: 1, party: "unknown" });
    if (table === "sms_campaigns") Object.assign(base, { id: `c${++seq}`, status: "queued" });
    if (table === "messaging_consent_log") Object.assign(base, { id: ++seq });
    return { ...base, ...row };
  };
  const conflict = (row: Row, except?: Row) =>
    (UNIQUE[table] ?? []).some((k) => row[k] != null && rows.some((r) => r !== except && r[k] === row[k]));

  const run = async () => {
    const info: OpInfo = { table, kind: op.kind, patch: (op as any).patch, row: (op as any).row };
    state.before?.(info);
    let result: { data: any; error: any; count?: number };
    if (op.kind === "insert") {
      const row = withDefaults(op.row);
      if (conflict(row)) result = { data: null, error: { code: "23505", message: "duplicate key value" } };
      else {
        rows.push(row);
        result = { data: single ? row : [row], error: null };
      }
    } else if (op.kind === "upsert") {
      const { row, key } = op;
      const hit = rows.find((r) => r[key] === row[key]);
      if (hit) for (const [k, v] of Object.entries(row)) if (v !== undefined) hit[k] = v;
      else rows.push(withDefaults(row));
      result = { data: null, error: null };
    } else {
      let matched = rows.filter((r) => filters.every((f) => f(r)));
      if (order) {
        const { col, asc } = order;
        matched = [...matched].sort((a, b) => (asc ? 1 : -1) * compare(a[col], b[col]));
      }
      matched = matched.slice(0, limit);
      if (op.kind === "update") {
        for (const r of matched) Object.assign(r, op.patch);
        info.matched = matched;
        result = { data: matched.map((r) => ({ ...r })), error: null };
      } else if (op.head) {
        result = { data: null, error: null, count: matched.length };
      } else {
        result = { data: single ? (matched[0] ? { ...matched[0] } : null) : matched.map((r) => ({ ...r })), error: null };
      }
    }
    state.after?.(info);
    return result;
  };
  const chain: any = {
    select: (_cols?: string, opts?: { head?: boolean }) => {
      if (op.kind === "select" && opts?.head) op = { kind: "select", head: true };
      return chain;
    },
    eq: (k: string, v: unknown) => (filters.push((r) => r[k] === v), chain),
    neq: (k: string, v: unknown) => (filters.push((r) => r[k] !== v), chain),
    in: (k: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[k])), chain),
    is: (k: string, v: unknown) => (filters.push((r) => (r[k] ?? null) === v), chain),
    lt: (k: string, v: unknown) => (filters.push((r) => r[k] != null && compare(r[k], v) < 0), chain),
    lte: (k: string, v: unknown) => (filters.push((r) => r[k] != null && compare(r[k], v) <= 0), chain),
    gte: (k: string, v: unknown) => (filters.push((r) => r[k] != null && compare(r[k], v) >= 0), chain),
    ilike: (k: string, p: string) => (filters.push((r) => likeToRegex(p).test(String(r[k] ?? ""))), chain),
    order: (col: string, o?: { ascending?: boolean }) => ((order = { col, asc: o?.ascending !== false }), chain),
    limit: (n: number) => ((limit = n), chain),
    maybeSingle: () => ((single = true), run()),
    single: () => ((single = true), run()),
    insert: (row: Row) => ((op = { kind: "insert", row }), chain),
    upsert: (row: Row, o?: { onConflict?: string }) => ((op = { kind: "upsert", row, key: o?.onConflict ?? "id" }), chain),
    update: (patch: Row) => ((op = { kind: "update", patch }), chain),
    then: (ok: any, bad: any) => run().then(ok, bad),
  };
  return chain;
}

const provider = {
  name: "twilio",
  async send(args: Row) {
    state.sends.push(args);
    return state.provider(args, state.sends.length);
  },
  verifyWebhook: () => true,
};
(globalThis as any).__smsTransport = { state, from, provider };

const root = fileURLToPath(new URL("../", import.meta.url));
const fake = (source: string) => `data:text/javascript,${encodeURIComponent(source)}`;
(nodeModule as any).registerHooks({
  resolve(specifier: string, context: any, next: any) {
    const g = "const t=globalThis.__smsTransport;";
    const doubles: Record<string, string> = {
      "next/cache": "export const revalidatePath=()=>{};",
      "next/headers": "export const headers=async()=>new Headers({'user-agent':'test','x-forwarded-for':'203.0.113.7'});",
      "@/lib/supabase/admin": g + "export const createAdminClient=()=>({from:t.from});",
      "@/lib/env": `export const env={siteUrl:${JSON.stringify(SITE)}};`,
      "@/lib/sms/settings":
        g +
        "export const getSmsSettings=async()=>({...t.state.settings,quietHours:{...t.state.settings.quietHours}});" +
        "export const hasCredentials=(s)=>Boolean(s.fromNumber&&s.accountSid&&s.authToken);" +
        "export const invalidateSmsSettings=()=>{};",
      "@/lib/sms/providers": g + "export const providerFor=()=>t.provider;",
      "@/lib/server-guards": g + "export const assertPermission=async()=>({userId:t.state.userId});",
      "@/lib/audit": "export const logAudit=async()=>{};",
      "@/lib/email/audience":
        g + "export const MAX_AUDIENCE=1000;export const resolveAudience=async()=>t.state.members;",
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

const { drainSmsQueue } = await import("./sms/queue.ts");
const { sendSms } = await import("./sms/send.ts");
const { grantConsent } = await import("./sms/consent.ts");
const { resolveSmsAudience } = await import("./sms/audience.ts");
const { cancelCampaign, cancelQueuedSms } = await import("../app/admin/sms/outbox/actions.ts");
const { sendSmsCampaign, sendTestSms } = await import("../app/admin/sms/blast/actions.ts");
const { DEFAULT_HELP_TEXT } = await import("./sms/policy.ts");

// ---------------------------------------------------------------------------

// A test that resets twice moves the clock rather than enabling it again.
const clocked = new WeakSet<object>();

function reset(t: any, at = NOON_ET) {
  if (clocked.has(t)) t.mock.timers.setTime(at);
  else {
    t.mock.timers.enable({ apis: ["Date"], now: at });
    clocked.add(t);
  }
  state.settings = {
    configured: true,
    readError: null,
    provider: "twilio",
    fromNumber: "+18005550100",
    accountSid: "AC-test",
    authToken: "token",
    smsPaused: false,
    maxSendsPerRun: 300,
    quietHours: { startHour: 9, endHour: 20 },
    helpText: DEFAULT_HELP_TEXT,
  };
  state.tables = {
    messaging_consent: [],
    messaging_consent_log: [],
    sms_outbox: [],
    sms_campaigns: [],
    sms_events: [],
    applications: [],
  };
  state.sends = [];
  state.provider = async (_args, n) => ({ ok: true, providerId: `SM-${n}` });
  state.before = null;
  state.after = null;
  state.userId = "admin-1";
  state.members = [];
}

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

const optedIn = (phone: string, over: Row = {}): Row => ({
  phone_e164: phone,
  party: "student",
  user_id: `stu-${phone.slice(-3)}`,
  transactional: true,
  promotional: false,
  opted_out_at: null,
  opted_out_source: null,
  opted_out_by: null,
  ...over,
});

const outboxRow = (id: string, phone: string, over: Row = {}): Row => ({
  id,
  to_phone: phone,
  party: "student",
  purpose: "transactional",
  body: "Kickoff is at 5pm ET today.",
  segments: 1,
  status: "pending",
  attempts: 0,
  send_after: ago(1),
  updated_at: ago(1),
  created_at: ago(1),
  campaign_id: null,
  ...over,
});

const outbox = (id: string) => state.tables.sms_outbox.find((r) => r.id === id)!;

// ---------------------------------------------------------------------------
// Stopping a campaign
// ---------------------------------------------------------------------------

test("stopping a campaign mid-drain stops the rows the drain already claimed", async (t) => {
  reset(t);
  state.tables.messaging_consent = [optedIn(P1), optedIn(P2), optedIn(P3)];
  state.tables.sms_campaigns = [{ id: "c1", name: "Kickoff", status: "sending" }];
  state.tables.sms_outbox = [P1, P2, P3].map((p, i) => outboxRow(`o${i + 1}`, p, { campaign_id: "c1" }));

  let stopMessage = "";
  state.provider = async (_args, n) => {
    // The admin clicks Stop while the first text is being handed over. All
    // three rows are claimed (`sending`) at this point.
    if (n === 1) {
      const res = await cancelCampaign("c1");
      assert.ok(res.ok, res.error);
      stopMessage = res.message ?? "";
    }
    return { ok: true, providerId: `SM-${n}` };
  };

  const report = await drainSmsQueue();
  assert.equal(state.sends.length, 1, "only the text already in flight went out");
  assert.equal(outbox("o1").status, "sent", "the in-flight one's real result wins");
  assert.equal(outbox("o2").status, "canceled");
  assert.equal(outbox("o3").status, "canceled");
  assert.equal(report.canceled, 2);
  assert.equal(state.tables.sms_campaigns[0].status, "canceled", "and the roll-up doesn't resurrect it");
  assert.equal(state.tables.sms_campaigns[0].sent_count, 1, "but its counters still refresh");
  assert.match(stopMessage, /may still arrive/);
});

test("stopping a campaign cancels rows waiting for a retry, and the retry pass never revives one", async (t) => {
  reset(t);
  state.tables.messaging_consent = [optedIn(P1), optedIn(P2), optedIn(P3)];
  state.tables.sms_campaigns = [{ id: "c1", name: "Kickoff", status: "sending" }];
  state.tables.sms_outbox = [
    outboxRow("pending", P1, { campaign_id: "c1" }),
    outboxRow("retrying", P2, { campaign_id: "c1", status: "failed", attempts: 1, updated_at: ago(20), last_error: "Twilio 503" }),
    outboxRow("done-trying", P3, { campaign_id: "c1", status: "failed", attempts: 3, updated_at: ago(20) }),
    outboxRow("sent", P3, { campaign_id: "c1", status: "sent", attempts: 1 }),
  ];
  const res = await cancelCampaign("c1");
  assert.ok(res.ok);
  assert.equal(outbox("pending").status, "canceled");
  assert.equal(outbox("retrying").status, "canceled", "a 5xx-failed row would have gone out in 5 minutes");
  assert.equal(outbox("done-trying").status, "failed");
  assert.equal(outbox("sent").status, "sent");

  // And a row that turned `failed` AFTER the stop — the send that was in
  // flight — is closed by the retry pass instead of being re-queued.
  outbox("retrying").status = "failed";
  const report = await drainSmsQueue();
  assert.equal(outbox("retrying").status, "canceled");
  assert.equal(report.retried, 0);
  assert.equal(report.canceled, 1);
  assert.equal(state.sends.length, 0);
});

test("a campaign row claimed after its campaign was stopped is closed, not sent", async (t) => {
  // A stop whose row update failed halfway: the campaign says canceled, a row
  // still says pending.
  reset(t);
  state.tables.messaging_consent = [optedIn(P1), optedIn(P2)];
  state.tables.sms_campaigns = [{ id: "c1", status: "canceled" }];
  state.tables.sms_outbox = [outboxRow("o1", P1, { campaign_id: "c1" }), outboxRow("o2", P2)];
  const report = await drainSmsQueue();
  assert.equal(outbox("o1").status, "canceled");
  assert.equal(outbox("o1").attempts, 0, "no attempt was made");
  assert.equal(outbox("o2").status, "sent", "rows outside the campaign are unaffected");
  assert.deepEqual(state.sends.map((s) => s.to), [P2]);
  assert.equal(report.canceled, 1);
});

test("a failed row waiting for its retry can be cancelled from the outbox", async (t) => {
  reset(t);
  state.tables.sms_outbox = [
    outboxRow("retrying", P1, { status: "failed", attempts: 1 }),
    outboxRow("capped", P2, { status: "failed", attempts: 3 }),
  ];
  assert.equal((await cancelQueuedSms("retrying")).ok, true);
  assert.equal(outbox("retrying").status, "canceled");
  assert.equal((await cancelQueuedSms("capped")).ok, false, "past the cap nothing will retry it");
  assert.equal(outbox("capped").status, "failed");
});

// ---------------------------------------------------------------------------
// Quiet hours and the pause switch
// ---------------------------------------------------------------------------

test("a quiet-hours hold costs no attempt, and can't revive a row cancelled meanwhile", async (t) => {
  reset(t, ELEVEN_PM_ET);
  state.tables.messaging_consent = [optedIn(P1), optedIn(P2)];
  state.tables.sms_outbox = [outboxRow("fresh", P1), outboxRow("second-try", P2, { attempts: 1 })];
  const report = await drainSmsQueue();
  assert.equal(report.deferred, 2);
  assert.equal(outbox("fresh").status, "pending");
  assert.equal(outbox("fresh").attempts, 0, "held overnight, not attempted");
  assert.equal(outbox("second-try").attempts, 1, "a retry keeps the attempts it really made");
  assert.equal(new Date(outbox("fresh").send_after).toISOString(), "2026-10-21T13:00:00.000Z", "9am ET");
  assert.equal(state.sends.length, 0);

  // Cancelled between the claim and the hold: it stays cancelled.
  reset(t, ELEVEN_PM_ET);
  state.tables.messaging_consent = [optedIn(P1)];
  state.tables.sms_outbox = [outboxRow("o1", P1)];
  state.after = (op) => {
    if (op.table === "sms_outbox" && op.kind === "update" && op.patch && Object.keys(op.patch).join() === "attempts") {
      outbox("o1").status = "canceled";
    }
  };
  await drainSmsQueue();
  assert.equal(outbox("o1").status, "canceled");
});

test("a row held a day at a time for an unsatisfiable window never reaches the attempt cap", async (t) => {
  reset(t);
  state.settings.quietHours = { startHour: 5, endHour: 5 };
  state.tables.messaging_consent = [optedIn(P1)];
  state.tables.sms_outbox = [outboxRow("o1", P1)];
  for (let day = 0; day < 4; day++) {
    outbox("o1").send_after = ago(1);
    await drainSmsQueue();
  }
  assert.equal(outbox("o1").status, "pending");
  assert.equal(outbox("o1").attempts, 0);
  assert.match(outbox("o1").last_error, /can't be satisfied/);
});

test("pausing mid-drain hands the rest of the batch back", async (t) => {
  reset(t);
  state.tables.messaging_consent = [optedIn(P1), optedIn(P2), optedIn(P3)];
  state.tables.sms_outbox = [P1, P2, P3].map((p, i) => outboxRow(`o${i + 1}`, p));
  state.provider = async (_args, n) => {
    if (n === 1) {
      state.settings.smsPaused = true; // flipped at /admin/sms/settings
      t.mock.timers.tick(4_000); // the drain re-reads the switch every few seconds
    }
    return { ok: true, providerId: `SM-${n}` };
  };
  const report = await drainSmsQueue();
  assert.equal(state.sends.length, 1);
  assert.equal(outbox("o2").status, "pending");
  assert.equal(outbox("o3").status, "pending");
  assert.equal(outbox("o2").attempts, 0, "the attempt counted at claim time is given back");
  assert.ok(report.errors.some((e) => /paused mid-run/.test(e)), report.errors.join("; "));
});

// ---------------------------------------------------------------------------
// Direct sends, the disclosure
// ---------------------------------------------------------------------------

test("a failed direct send is written at the cap, so the drain doesn't send it again later", async (t) => {
  reset(t);
  state.tables.messaging_consent = [optedIn(P1)];
  state.provider = async () => ({ ok: false, reason: "Twilio request timed out", retryable: true });
  const result = await sendSms({ to: P1, body: "Test.", purpose: "transactional", templateKey: "sms.campaign_test" });
  assert.equal(result.ok, false);
  const [row] = state.tables.sms_outbox;
  assert.equal(row.status, "failed");
  assert.equal(row.attempts, 3);

  // Half an hour later the retry pass would have re-sent it twice over.
  t.mock.timers.tick(35 * 60_000);
  state.provider = async (_a, n) => ({ ok: true, providerId: `SM-${n}` });
  const report = await drainSmsQueue();
  assert.equal(report.retried, 0);
  assert.equal(state.sends.length, 1, "only the original attempt");
});

test("the first text to a number gets the full disclosure even when the body says STOP", async (t) => {
  reset(t);
  state.tables.messaging_consent = [optedIn(P1)];
  state.tables.sms_outbox = [outboxRow("o1", P1, { body: "Kickoff moved to 5pm. Text STOP to opt out." })];
  await drainSmsQueue();
  assert.equal(state.sends[0].body, `Kickoff moved to 5pm. Text STOP to opt out.\n\n${DEFAULT_HELP_TEXT}`);
  // And the receipt URL asks Twilio to retry a 5xx.
  assert.equal(state.sends[0].statusCallback, `${SITE}/api/webhooks/sms#rp=ct,5xx&rc=3`);
});

// ---------------------------------------------------------------------------
// Opt-outs the webhook couldn't record
// ---------------------------------------------------------------------------

test("the drain records an opt-out text the webhook failed to write, even while paused", async (t) => {
  reset(t);
  state.settings.smsPaused = true;
  state.tables.messaging_consent = [optedIn(P1)];
  state.tables.sms_outbox = [outboxRow("o1", P1)];
  state.tables.sms_events = [
    { event_key: "SM1:inbound", phone_e164: P1, direction: "inbound", body: "please stop texting me", created_at: ago(30) },
  ];
  const report = await drainSmsQueue();
  assert.equal(report.reconciled, 1);
  assert.equal(report.paused, true);
  const consent = state.tables.messaging_consent[0];
  assert.ok(consent.opted_out_at);
  assert.equal(consent.opted_out_source, "sms_stop");
  assert.equal(state.tables.messaging_consent_log.at(-1)?.inbound_body, "please stop texting me");
  assert.equal(outbox("o1").status, "canceled", "and what was queued to them is cancelled");
  assert.equal(state.sends.length, 0, "no late confirmation text");

  // Recorded once, not every tick.
  const again = await drainSmsQueue();
  assert.equal(again.reconciled, 0);
  assert.equal(state.tables.messaging_consent_log.length, 1);
});

// ---------------------------------------------------------------------------
// The consent writer
// ---------------------------------------------------------------------------

const grant = (over: Row = {}) =>
  grantConsent({
    phone: P1,
    userId: "stu-101",
    party: "student",
    purposes: ["transactional"],
    consentText: "Text me program updates.",
    source: "dashboard_phone",
    ...over,
  } as any);

test("a STOP landing while an opt-in is being saved is not overwritten", async (t) => {
  reset(t);
  state.tables.messaging_consent = [optedIn(P1, { transactional: false })];
  let landed = false;
  state.before = (op) => {
    if (!landed && op.table === "messaging_consent" && op.kind === "update") {
      landed = true; // the phone's STOP commits between the grant's read and write
      Object.assign(state.tables.messaging_consent[0], {
        opted_out_at: new Date().toISOString(),
        opted_out_source: "sms_stop",
      });
    }
  };
  const res = await grant();
  assert.equal(res.ok, false);
  assert.match((res as any).error, /replied STOP/);
  const row = state.tables.messaging_consent[0];
  assert.ok(row.opted_out_at, "the STOP stands");
  assert.equal(row.opted_out_source, "sms_stop");
});

test("a STOP that creates the row while a first opt-in is being saved also stands", async (t) => {
  reset(t);
  state.before = (op) => {
    if (op.table === "messaging_consent" && op.kind === "insert" && state.tables.messaging_consent.length === 0) {
      state.tables.messaging_consent.push(
        optedIn(P1, { party: "unknown", transactional: false, opted_out_at: new Date().toISOString(), opted_out_source: "sms_stop" }),
      );
    }
  };
  const res = await grant();
  assert.equal(res.ok, false);
  assert.equal(state.tables.messaging_consent.length, 1);
  assert.ok(state.tables.messaging_consent[0].opted_out_at);
});

test("an uncontested opt-in is written, and a dashboard opt-out by another account isn't lifted", async (t) => {
  reset(t);
  assert.deepEqual(await grant(), { ok: true });
  const row = state.tables.messaging_consent[0];
  assert.equal(row.transactional, true);
  assert.equal(row.user_id, "stu-101");

  // Student A turns texts off; sibling B saves the same number with the box ticked.
  Object.assign(row, { opted_out_at: new Date().toISOString(), opted_out_source: "dashboard_phone", opted_out_by: "stu-101" });
  const sibling = await grant({ userId: "stu-999" });
  assert.equal(sibling.ok, false);
  assert.ok(row.opted_out_at, "A's opt-out stands");
  // A themselves can turn it back on.
  assert.deepEqual(await grant(), { ok: true });
  assert.equal(row.opted_out_at, null);
  assert.equal(row.opted_out_by, null);
});

test("an opt-in for a number outside +1 is refused before anything is written", async (t) => {
  // The send gate refuses every number a toll-free sender can't reach, so a
  // grant for one was a permission nothing would use, under a "Texts are on".
  reset(t);
  for (const phone of ["+447700900123", "+919876543210", "+5215512345678"]) {
    const res = await grant({ phone });
    assert.equal(res.ok, false, phone);
    assert.match((res as any).error, /start with \+1/, phone);
  }
  assert.equal(state.tables.messaging_consent.length, 0);
  assert.equal(state.tables.messaging_consent_log.length, 0, "no ledger row either");
  // The same rule as the gate: a +1 number opts in.
  assert.deepEqual(await grant(), { ok: true });
});

// ---------------------------------------------------------------------------
// The composer's server actions
// ---------------------------------------------------------------------------

test("the own-phone test opt-in refuses a number on a student's application", async (t) => {
  reset(t);
  // The student never opted in, so there's no consent row to say it's theirs.
  state.tables.applications = [{ user_id: "stu-101", phone: "(609) 555-0101" }];
  const out = await sendTestSms("609.555.0101", "Kickoff is at 5pm.", true);
  assert.equal(out.ran, false);
  assert.match((out as any).error, /student's application/);
  assert.equal(state.tables.messaging_consent.length, 0, "no consent recorded");
  assert.equal(state.sends.length, 0);

  // The admin's own number, on nobody else's application, works.
  state.tables.applications.push({ user_id: "admin-1", phone: "609-555-0102" });
  const own = await sendTestSms("6095550102", "Kickoff is at 5pm.", true);
  assert.equal(own.ran, true);
  assert.equal((own as any).chainProven, true);
  assert.equal(state.tables.messaging_consent[0].party, "unknown");
});

test("a test opt-in never puts a number into a campaign audience", async (t) => {
  reset(t);
  state.members = [{ userId: "stu-101", name: "Sam" }];
  state.tables.applications = [{ user_id: "stu-101", phone: "609-555-0101", age: 16, created_at: ago(100) }];
  state.tables.messaging_consent = [optedIn(P1, { party: "unknown", user_id: "admin-1" })];
  const audience = await resolveSmsAudience({ segment: "enrolled" });
  assert.equal(audience.recipients.length, 0);
  assert.equal(audience.counts.no_consent, 1);
  // The student's own tick does.
  state.tables.messaging_consent[0].party = "student";
  assert.equal((await resolveSmsAudience({ segment: "enrolled" })).recipients.length, 1);
});

test("a test parked by the pause switch doesn't unlock the campaign; one held for quiet hours does", async (t) => {
  reset(t);
  state.tables.messaging_consent = [optedIn(P2, { party: "unknown" })];
  state.settings.smsPaused = true;
  const paused = await sendTestSms(P2, "Kickoff is at 5pm.", false);
  assert.equal(paused.ran, true);
  assert.equal((paused as any).result.queuedReason, "paused");
  assert.equal((paused as any).chainProven, false);

  reset(t, ELEVEN_PM_ET);
  state.tables.messaging_consent = [optedIn(P2, { party: "unknown" })];
  const night = await sendTestSms(P2, "Kickoff is at 5pm.", false);
  assert.equal((night as any).result.queuedReason, "quiet_hours");
  assert.equal((night as any).chainProven, true);
});

test("the campaign action queues nothing while there are no credentials", async (t) => {
  reset(t);
  state.settings.authToken = null;
  state.members = [{ userId: "stu-101", name: "Sam" }];
  state.tables.applications = [{ user_id: "stu-101", phone: "609-555-0101", age: 16, created_at: ago(100) }];
  state.tables.messaging_consent = [optedIn(P1)];
  const res = await sendSmsCampaign({
    name: "Kickoff",
    body: "Kickoff is at 5pm.",
    segment: "enrolled",
    clientKey: "draft-key-123",
  });
  assert.equal(res.ok, false);
  assert.match((res as any).error, /isn't sending yet/);
  assert.deepEqual(state.tables.sms_outbox, []);
  assert.deepEqual(state.tables.sms_campaigns, []);
});
