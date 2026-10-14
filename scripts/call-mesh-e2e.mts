/**
 * 1:1 mesh end-to-end proof: a call with a co-host added while it runs.
 *
 *   npm run dev            # in another terminal
 *   npm run call-mesh-e2e
 *   npm run call-mesh-e2e -- --headed
 *
 * A 1:1 is a mesh of broadcasters, and every pair of people on it negotiates
 * on its own private line (pairTopic in lib/live-signal.ts), which only those
 * two are given. That closed a forgery — with every party holding every other
 * party's inbox, a student could offer on a staff inbox as a made-up "Admin"
 * or as a real co-host — but it also means nobody can hear an offer on a line
 * they have not been told about yet. So this walks the case that leans on it
 * hardest, in real browsers through the real app:
 *
 *   - the host and the student join a call nobody has answered ('invited'
 *     is joinable like 'accepted') and each decodes the other;
 *   - a mentor is added as a co-host mid-call and joins: every one of the
 *     three ends up decoding BOTH others — the people already in the room
 *     learn the newcomer's line from their heartbeat, and whichever side
 *     offered before the other was listening is asked again.
 *
 * Run it a few times: which of the three offers to whom follows the random
 * user ids, and each ordering takes a different path through the engine.
 *
 * Every account and row it creates is removed in a finally block.
 */
import { randomBytes } from "node:crypto";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const headed = process.argv.includes("--headed");

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing ${name}. Run via npm so .env.local is loaded.`);
    process.exit(1);
  }
  return v;
}

const url = required("NEXT_PUBLIC_SUPABASE_URL");
const serviceKey = required("SUPABASE_SERVICE_ROLE_KEY");
const anonKey = required("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const projectRef = new URL(url).hostname.split(".")[0];
const COOKIE_NAME = `sb-${projectRef}-auth-token`;
const MAX_CHUNK = 3180;
const adm = {
  apikey: serviceKey,
  Authorization: `Bearer ${serviceKey}`,
  "Content-Type": "application/json",
};

let failures = 0;
const pass = (m: string) => console.log(`  ok    ${m}`);
const info = (m: string) => console.log(`        ${m}`);
function check(cond: boolean, m: string) {
  if (cond) pass(m);
  else {
    failures++;
    console.log(`  FAIL  ${m}`);
  }
}

// --- fixtures ---------------------------------------------------------------

const stamp = String(process.pid);
/** Random per run, never written down: an orphaned account is unusable. */
const PASSWORD = `e2e-${randomBytes(18).toString("base64url")}`;
/** Its own prefix, on a reserved TLD: another script's reaper must not take these. */
const emailFor = (tag: string) => `e2e-callmesh-${tag}-${stamp}@example.invalid`;

/** Delete accounts an earlier run failed to clean up (killed before `finally`). */
async function reapOrphans(): Promise<void> {
  const res = await fetch(
    `${url}/rest/v1/profiles?select=id,email&email=like.e2e-callmesh-*@example.invalid`,
    { headers: adm },
  );
  if (!res.ok) return;
  const rows = (await res.json()) as { id: string; email: string }[];
  for (const r of rows) {
    if (!/^e2e-callmesh-[a-z0-9-]+@example\.invalid$/.test(r.email ?? "")) continue;
    await fetch(`${url}/auth/v1/admin/users/${r.id}`, {
      method: "DELETE",
      headers: adm,
    }).catch(() => {});
    console.log(`  reaped orphaned test account ${r.email}`);
  }
}

const createdUsers: string[] = [];
let createdInviteId: string | null = null;

async function createUser(tag: string, role: string, name: string) {
  const email = emailFor(tag);
  const res = await fetch(`${url}/auth/v1/admin/users`, {
    method: "POST",
    headers: adm,
    body: JSON.stringify({ email, password: PASSWORD, email_confirm: true }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`createUser ${email}: ${JSON.stringify(body)}`);
  createdUsers.push(body.id);
  const patch = await fetch(`${url}/rest/v1/profiles?id=eq.${body.id}`, {
    method: "PATCH",
    headers: adm,
    body: JSON.stringify({ role, full_name: name }),
  });
  if (!patch.ok) throw new Error(`setRole ${email}: ${await patch.text()}`);
  return { id: body.id as string, email };
}

async function sessionCookies(email: string) {
  const res = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: anonKey, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const session = await res.json();
  if (!res.ok) throw new Error(`signIn ${email}: ${JSON.stringify(session)}`);
  const value =
    "base64-" + Buffer.from(JSON.stringify(session), "utf8").toString("base64url");
  if (value.length <= MAX_CHUNK) return [{ name: COOKIE_NAME, value }];
  const parts: { name: string; value: string }[] = [];
  for (let i = 0, n = 0; i < value.length; i += MAX_CHUNK, n++) {
    parts.push({ name: `${COOKIE_NAME}.${n}`, value: value.slice(i, i + MAX_CHUNK) });
  }
  return parts;
}

/** An unanswered 1:1 between the host and the student, started two minutes ago. */
async function createInvitedCall(hostId: string, inviteeId: string): Promise<string> {
  const res = await fetch(`${url}/rest/v1/call_invites`, {
    method: "POST",
    headers: { ...adm, Prefer: "return=representation" },
    body: JSON.stringify({
      host_id: hostId,
      invitee_id: inviteeId,
      starts_at: new Date(Date.now() - 2 * 60_000).toISOString(),
      duration_minutes: 30,
      topic: `E2E mesh ${stamp}`,
      status: "invited",
    }),
  });
  const rows = await res.json();
  if (!res.ok) throw new Error(`createCall: ${JSON.stringify(rows)}`);
  createdInviteId = rows[0].id;
  return rows[0].id;
}

async function cleanup() {
  if (createdInviteId) {
    // Co-host rows go with the invite (on delete cascade).
    await fetch(`${url}/rest/v1/call_invites?id=eq.${createdInviteId}`, {
      method: "DELETE",
      headers: adm,
    }).catch(() => {});
  }
  for (const id of createdUsers) {
    await fetch(`${url}/auth/v1/admin/users/${id}`, {
      method: "DELETE",
      headers: adm,
    }).catch(() => {});
  }
}

// --- browser helpers --------------------------------------------------------

/** Capture every RTCPeerConnection the page builds, before any app script. */
const TRACE_PCS = `
window.__b0pcs = [];
const Native = window.RTCPeerConnection;
window.RTCPeerConnection = function (...args) {
  const pc = new Native(...args);
  window.__b0pcs.push(pc);
  return pc;
};
window.RTCPeerConnection.prototype = Native.prototype;
Object.assign(window.RTCPeerConnection, Native);
`;

/** Each open connection's state and decoded inbound video frames. */
const LINKS = `(async () => {
  const out = [];
  for (const pc of window.__b0pcs || []) {
    if (pc.connectionState === "closed") continue;
    let frames = 0;
    try {
      (await pc.getStats()).forEach((s) => {
        if (s.type === "inbound-rtp" && s.kind === "video") frames += s.framesDecoded || 0;
      });
    } catch {}
    out.push({ state: pc.connectionState, frames });
  }
  return out;
})()`;

async function until<T>(
  label: string,
  fn: () => Promise<T | null | undefined | false>,
  timeoutMs = 60_000,
): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) return v as T;
    } catch {
      /* page mid-navigation; try again */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  info(`timed out waiting for ${label} (${timeoutMs / 1000}s)`);
  return null;
}

async function openAs(
  browser: Browser,
  email: string,
  path: string,
  label: string,
): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({
    permissions: ["camera", "microphone"],
    baseURL: BASE,
  });
  await ctx.addCookies(
    (await sessionCookies(email)).map((c) => ({
      ...c,
      url: BASE,
      httpOnly: false,
      secure: false,
      sameSite: "Lax" as const,
    })),
  );
  await ctx.addInitScript(TRACE_PCS);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => info(`[${label}] page error: ${e.message}`));
  // next dev compiles a room route on its first visit, which on a loaded
  // machine has taken ~25 s and answered just under Playwright's 30 s default.
  // A slow first compile is not a failure; give it the same room as
  // webinar-panel-e2e and room-screens.
  await page.goto(`${BASE}${path}`, {
    waitUntil: "domcontentloaded",
    timeout: 180_000,
  });
  return { ctx, page };
}

/** Press the green room's join button once it is ready. */
async function enterRoom(page: Page, label: string): Promise<boolean> {
  const button = page.getByRole("button", { name: /^(start|join|join call)$/i });
  const ok = await until(
    `${label} green room`,
    async () => (await button.count()) > 0 && (await button.first().isEnabled()),
    90_000,
  );
  if (!ok) return false;
  await button.first().click();
  return true;
}

/** How many of the page's connections are up AND decoding climbing video. */
async function decodingLinks(page: Page): Promise<number> {
  const a = (await page.evaluate(LINKS)) as { state: string; frames: number }[];
  await new Promise((r) => setTimeout(r, 1500));
  const b = (await page.evaluate(LINKS)) as { state: string; frames: number }[];
  let n = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (b[i].state === "connected" && b[i].frames > a[i].frames) n++;
  }
  return n;
}

// --- the test ---------------------------------------------------------------

async function main() {
  console.log(`\ncall-mesh-e2e\n`);
  const health = await fetch(BASE).catch(() => null);
  if (!health?.ok) {
    console.error(`No dev server at ${BASE}. Run \`npm run dev\` first.`);
    process.exit(1);
  }
  if (!/localhost|127\.0\.0\.1/.test(url)) {
    console.log(`  !!  writing test rows to Supabase project ${projectRef}\n`);
  }

  await reapOrphans();
  console.log("fixtures");
  const host = await createUser("host", "admin", "E2E Host");
  const student = await createUser("student", "student", "E2E Student");
  const mentor = await createUser("mentor", "mentor", "E2E Mentor");
  const inviteId = await createInvitedCall(host.id, student.id);
  pass("admin + student + mentor accounts, and an unanswered call that started");
  // Who offers to whom is decided by id order, so say which run this was.
  const order = [
    ["host", host.id],
    ["student", student.id],
    ["mentor", mentor.id],
  ]
    .sort((a, b) => (a[1] < b[1] ? -1 : 1))
    .map((p) => p[0]);
  info(`id order: ${order.join(" < ")}`);

  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({
      headless: !headed,
      args: [
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
        "--autoplay-policy=no-user-gesture-required",
      ],
    });
    const path = `/dashboard/calls/${inviteId}/live`;

    console.log("\ntwo people");
    const h = await openAs(browser, host.email, path, "host");
    const s = await openAs(browser, student.email, path, "student");
    check(await enterRoom(h.page, "host"), "the host joined a call nobody has answered");
    check(await enterRoom(s.page, "student"), "the student joined it too");
    check(
      !!(await until("host to decode the student", async () => (await decodingLinks(h.page)) === 1)),
      "the host decodes the student",
    );
    check(
      !!(await until("student to decode the host", async () => (await decodingLinks(s.page)) === 1)),
      "the student decodes the host",
    );

    console.log("\na co-host added mid-call");
    const added = await fetch(`${url}/rest/v1/call_invite_cohosts`, {
      method: "POST",
      headers: adm,
      body: JSON.stringify({ invite_id: inviteId, profile_id: mentor.id }),
    });
    check(added.ok, "the mentor is added to the running call");
    const m = await openAs(browser, mentor.email, path, "mentor");
    check(await enterRoom(m.page, "mentor"), "the mentor joined");
    const from = Date.now();
    const mesh = await until(
      "everyone to decode both others",
      async () => {
        const counts = await Promise.all([h, s, m].map((p) => decodingLinks(p.page)));
        return counts.every((n) => n === 2) ? counts : null;
      },
      90_000,
    );
    check(!!mesh, "everyone decodes BOTH others (a full mesh, one line per pair)");
    if (mesh) info(`${((Date.now() - from) / 1000).toFixed(1)}s after the mentor joined`);
    else {
      for (const [p, label] of [
        [h, "host"],
        [s, "student"],
        [m, "mentor"],
      ] as const) {
        info(`${label}: ${JSON.stringify(await p.page.evaluate(LINKS))}`);
      }
    }
  } finally {
    await browser?.close().catch(() => {});
    await cleanup();
    info("test accounts and call removed");
  }

  if (failures > 0) {
    console.log(`\ncall-mesh-e2e failed: ${failures} check(s)\n`);
    process.exit(1);
  }
  console.log("\ncall-mesh-e2e passed\n");
}

main().catch(async (err) => {
  console.error("\ncall-mesh-e2e failed:\n", err);
  await cleanup();
  process.exit(1);
});
