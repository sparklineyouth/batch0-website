/**
 * Webinar end-to-end proof: does a student actually see and hear the host?
 *
 *   npm run dev          # in another terminal
 *   npm run webinar-e2e
 *   npm run webinar-e2e -- --headed    # watch it happen
 *   npm run webinar-e2e -- --provider=daily
 *
 * Why this exists
 * ---------------
 * `daily-doctor` passed every check for months while hosted webinars were
 * completely broken. It exercised the REST plane — create a room, mint a
 * token, decode the claims — and every one of those still works. What did not
 * work was joining: the Daily account refuses every media session with
 * `account-missing-payment-method`, including into a bare public room with no
 * properties set. A REST-shaped check can never see that.
 *
 * So this asserts on decoded media in a real browser, through the real app:
 * real accounts, real Supabase sessions, the real `/dashboard/events/[id]/live`
 * page, the real green room, the real signalling. Chromium's fake device emits
 * a moving pattern and a tone, so a climbing decoded-frame count is the
 * assertion — bytes arrived, got decoded, and kept coming. A connection that
 * negotiates and then delivers nothing, which is the most common way a call is
 * "broken" in front of people, fails here instead of on Sunday.
 *
 * It also asserts the three things that make a webinar a webinar rather than a
 * group call, all of which are invisible until they are wrong in public:
 * the viewer cannot broadcast, the viewer cannot see the audience, and the
 * host can.
 *
 * And it walks the exits, because a room nobody can leave or close properly is
 * as broken as one nobody can enter:
 *   - the host is an ADMIN (profiles.role = 'admin') — an admin must host,
 *     never be downgraded to a viewer;
 *   - a viewer presses Leave, lands on "You've left", presses Rejoin and
 *     decodes the host again on a fresh connection;
 *   - the host presses End for everyone (arm, then confirm): every viewer is
 *     moved to "This webinar has ended" within seconds, their connections
 *     close and frames stop, and a fresh join is refused;
 *   - the host presses Reopen, goes back on air, and the ended viewer is
 *     offered Rejoin (the ended screen's slow poll) and decodes video again;
 *   - the 1:1 is hosted by a MENTOR (the live-room middleware exemption):
 *     both people are shown the recording notice before they join, the
 *     mentor's End call puts both sides on "This call has ended" and marks
 *     the call completed, the mentor lands back on their own calls page, and
 *     the mentor's browser — the side that records — has uploaded the call.
 *
 * Every account, row and stored file it creates is removed in a finally
 * block, including on failure.
 */

import { randomBytes } from "node:crypto";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const headed = process.argv.includes("--headed");
const providerArg = process.argv.find((a) => a.startsWith("--provider="));
const PROVIDER = providerArg ? providerArg.split("=")[1] : "builtin";

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
const HOST_EMAIL = `e2e-webinar-host-${stamp}@example.invalid`;
const VIEWER_EMAIL = `e2e-webinar-viewer-${stamp}@example.invalid`;
const MENTOR_EMAIL = `e2e-webinar-mentor-${stamp}@example.invalid`;
/**
 * A fresh password every run, and never one that is written down.
 *
 * This used to be the constant `"e2e-Test-Password-9271"`, and that combined
 * with the account this script creates — role `admin`, `email_confirm: true` —
 * into a real hole. Cleanup is a `finally` block, and a `finally` does not run
 * when the process is killed: a ^C, an OOM, a closed laptop, a CI timeout.
 * Each of those leaves a live ADMIN account on whatever database .env.local
 * points at, signed in to by anyone who can read this file — because the
 * password was in it.
 *
 * That is not hypothetical. A run on 2026-09-20 left exactly that account
 * behind, and it sat in production until it was found the next day.
 *
 * Randomising it makes an orphan inert: nobody can sign in as it, because the
 * only process that ever knew the password has exited. `reapOrphans` then
 * removes it on the next run regardless.
 */
const PASSWORD = `e2e-${randomBytes(18).toString("base64url")}`;

/**
 * Delete test accounts a previous run failed to clean up.
 *
 * The belt to `finally`'s braces. Scoped as tightly as it can be — the exact
 * `e2e-webinar-*@example.invalid` shape this script mints, on a reserved TLD
 * that can never belong to a real person — so it cannot touch a real account
 * however badly it is invoked.
 */
async function reapOrphans(): Promise<void> {
  const res = await fetch(
    `${url}/rest/v1/profiles?select=id,email&email=like.e2e-webinar-*@example.invalid`,
    { headers: adm },
  );
  if (!res.ok) return;
  const rows = (await res.json()) as { id: string; email: string }[];
  for (const r of rows) {
    if (!/^e2e-webinar-[a-z0-9-]+@example\.invalid$/.test(r.email ?? "")) continue;
    await fetch(`${url}/auth/v1/admin/users/${r.id}`, {
      method: "DELETE",
      headers: adm,
    }).catch(() => {});
    console.log(`  reaped orphaned test account ${r.email}`);
  }
}

const createdUsers: string[] = [];
let createdEventId: string | null = null;
let createdInviteId: string | null = null;

async function createUser(email: string, role: string): Promise<string> {
  const res = await fetch(`${url}/auth/v1/admin/users`, {
    method: "POST",
    headers: adm,
    body: JSON.stringify({ email, password: PASSWORD, email_confirm: true }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`createUser ${email}: ${JSON.stringify(body)}`);
  createdUsers.push(body.id);
  // The on_auth_user_created trigger makes the profile; set role + name on it.
  const patch = await fetch(`${url}/rest/v1/profiles?id=eq.${body.id}`, {
    method: "PATCH",
    headers: { ...adm, Prefer: "return=representation" },
    body: JSON.stringify({
      role,
      full_name:
        role === "admin"
          ? "E2E Host"
          : role === "mentor"
            ? "E2E Mentor"
            : "E2E Student",
    }),
  });
  if (!patch.ok) throw new Error(`setRole ${email}: ${await patch.text()}`);
  return body.id;
}

/** Sign in for real and encode the session the way @supabase/ssr expects. */
async function sessionCookies(
  email: string,
): Promise<{ name: string; value: string }[]> {
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

/**
 * A webinar that is live right now.
 *
 * Starts five minutes ago and runs an hour, so it sits squarely inside
 * joinState()'s window rather than on either boundary — a test that has to be
 * run before the top of the hour is a test nobody runs. It must have STARTED,
 * too: End for everyone, which the run walks below, does not exist before a
 * webinar's start (webinarHasBegun in lib/live.ts). `visibility: public` so
 * the viewer needs no enrolment, which keeps this about the video path.
 */
async function createLiveWebinar(): Promise<string> {
  const now = Date.now();
  const res = await fetch(`${url}/rest/v1/events`, {
    method: "POST",
    headers: { ...adm, Prefer: "return=representation" },
    body: JSON.stringify({
      title: `E2E Webinar ${stamp}`,
      description: "Automated end-to-end check.",
      type: "workshop",
      starts_at: new Date(now - 5 * 60_000).toISOString(),
      ends_at: new Date(now + 55 * 60_000).toISOString(),
      visibility: "public",
      live_mode: "hosted",
    }),
  });
  const rows = await res.json();
  if (!res.ok) throw new Error(`createEvent: ${JSON.stringify(rows)}`);
  createdEventId = rows[0].id;
  return rows[0].id;
}

/**
 * An accepted 1:1 between the two accounts, happening right now.
 *
 * `accepted` because the join page refuses anything else — an invite nobody
 * agreed to is not a room either party may walk into.
 */
async function createAcceptedCall(
  hostId: string,
  inviteeId: string,
): Promise<string> {
  const res = await fetch(`${url}/rest/v1/call_invites`, {
    method: "POST",
    headers: { ...adm, Prefer: "return=representation" },
    body: JSON.stringify({
      host_id: hostId,
      invitee_id: inviteeId,
      starts_at: new Date(Date.now() - 2 * 60_000).toISOString(),
      duration_minutes: 30,
      topic: `E2E call ${stamp}`,
      status: "accepted",
    }),
  });
  const rows = await res.json();
  if (!res.ok) throw new Error(`createCall: ${JSON.stringify(rows)}`);
  createdInviteId = rows[0].id;
  return rows[0].id;
}

/**
 * Every object under `prefix` in `bucket`, removed. Best-effort, like the rest
 * of cleanup — a missing bucket (nothing was ever recorded) is simply empty.
 * Folders are walked, because a recording lands one level down.
 */
async function removeStoragePrefix(bucket: string, prefix: string): Promise<void> {
  const paths: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    const res = await fetch(`${url}/storage/v1/object/list/${bucket}`, {
      method: "POST",
      headers: adm,
      body: JSON.stringify({ prefix: dir, limit: 1000, offset: 0 }),
    }).catch(() => null);
    if (!res?.ok) return;
    const items = (await res.json()) as { name: string; id: string | null }[];
    for (const it of items) {
      const full = `${dir}/${it.name}`;
      // A folder has no id in a Storage listing.
      if (it.id) paths.push(full);
      else await walk(full);
    }
  };
  await walk(prefix);
  if (paths.length === 0) return;
  await fetch(`${url}/storage/v1/object/${bucket}`, {
    method: "DELETE",
    headers: adm,
    body: JSON.stringify({ prefixes: paths }),
  }).catch(() => {});
}

/** The objects in a 1:1's recording folder (lib/call-recording.ts). */
async function callRecordingFiles(inviteId: string): Promise<string[]> {
  const res = await fetch(`${url}/storage/v1/object/list/call-recordings`, {
    method: "POST",
    headers: adm,
    body: JSON.stringify({
      prefix: `calls/${inviteId}/recording`,
      limit: 100,
      offset: 0,
    }),
  }).catch(() => null);
  if (!res?.ok) return [];
  const items = (await res.json()) as { name: string; id: string | null }[];
  return items.filter((i) => !!i.id).map((i) => i.name);
}

async function cleanup() {
  // Recordings first, while the rows that name them still exist. The 1:1 is
  // recorded from the host's browser into the private call-recordings bucket
  // (no rows — the folder is the record); a webinar with auto-record on would
  // put segments in webinar-media with an event_assets row each. The test
  // webinar leaves auto-record off, but a run against a database whose
  // default changed must not leave a recording of test accounts behind.
  if (createdInviteId) {
    await removeStoragePrefix("call-recordings", `calls/${createdInviteId}`);
  }
  if (createdEventId) {
    await fetch(`${url}/rest/v1/event_assets?event_id=eq.${createdEventId}`, {
      method: "DELETE",
      headers: adm,
    }).catch(() => {});
    await removeStoragePrefix("webinar-media", createdEventId);
  }
  // End / Reopen / End call write audit entries against the test event and
  // call. They name only these throwaway rows, so they go with them.
  for (const target of [createdEventId, createdInviteId]) {
    if (!target) continue;
    await fetch(`${url}/rest/v1/audit_log?target_id=eq.${target}`, {
      method: "DELETE",
      headers: adm,
    }).catch(() => {});
  }
  if (createdInviteId) {
    await fetch(`${url}/rest/v1/call_invites?id=eq.${createdInviteId}`, {
      method: "DELETE",
      headers: adm,
    }).catch(() => {});
  }
  if (createdEventId) {
    await fetch(`${url}/rest/v1/live_participants?event_id=eq.${createdEventId}`, {
      method: "DELETE",
      headers: adm,
    }).catch(() => {});
    await fetch(`${url}/rest/v1/events?id=eq.${createdEventId}`, {
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

/** Poll until `fn` returns truthy, or give up. */
async function until<T>(
  label: string,
  fn: () => Promise<T | null | undefined | false>,
  timeoutMs = 45_000,
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

/**
 * Total decoded inbound video frames across every peer connection on the page.
 *
 * Read straight from `getStats()` rather than from anything the app reports,
 * so a UI that claims to be connected cannot make this pass. Two reads a beat
 * apart is the real assertion: a frozen track and a working one are identical
 * in a single sample.
 */
const INBOUND_FRAMES = `(async () => {
  const pcs = window.__b0pcs || [];
  let frames = 0, bytes = 0, audio = 0;
  for (const pc of pcs) {
    let report;
    try { report = await pc.getStats(); } catch { continue; }
    report.forEach((s) => {
      if (s.type === "inbound-rtp" && s.kind === "video") {
        frames += s.framesDecoded || 0;
        bytes += s.bytesReceived || 0;
      }
      if (s.type === "inbound-rtp" && s.kind === "audio") {
        audio += s.bytesReceived || 0;
      }
    });
  }
  return { frames, bytes, audio, pcs: pcs.length };
})()`;

/**
 * Capture every RTCPeerConnection the page builds.
 *
 * Injected before any app script runs, so the engine's connections are caught
 * as they are constructed. This is the only hook the test needs into the app —
 * everything else is asserted through the real UI.
 */
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
  const cookies = await sessionCookies(email);
  await ctx.addCookies(
    cookies.map((c) => ({
      name: c.name,
      value: c.value,
      url: BASE,
      httpOnly: false,
      secure: false,
      sameSite: "Lax" as const,
    })),
  );
  await ctx.addInitScript(TRACE_PCS);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => info(`[${label}] page error: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") info(`[${label}] console: ${m.text().slice(0, 200)}`);
  });
  await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded" });
  return { ctx, page };
}

/** Click the green room's join button, whatever it is labelled. */
async function enterRoom(page: Page, label: string): Promise<boolean> {
  // "Start" (webinar host), "Join" (viewer), "Join call" (either side of a 1:1).
  const button = page.getByRole("button", { name: /^(start|join|join call)$/i });
  const ok = await until(
    `${label} green room`,
    async () =>
      (await button.count()) > 0 && (await button.first().isEnabled()),
    60_000,
  );
  if (!ok) {
    const body = (await page.locator("body").innerText().catch(() => "")) || "";
    info(`[${label}] page said: ${body.slice(0, 300).replace(/\s+/g, " ")}`);
    return false;
  }
  await button.first().click();
  return true;
}

/**
 * Decoded inbound video frames on the peer connections built AFTER the first
 * `from` — i.e. on a fresh session. A Rejoin builds new connections; the old,
 * closed ones must not be allowed to make a stalled rejoin look healthy.
 */
const framesSince = (from: number) => `(async () => {
  const pcs = (window.__b0pcs || []).slice(${from});
  let frames = 0;
  for (const pc of pcs) {
    let report;
    try { report = await pc.getStats(); } catch { continue; }
    report.forEach((s) => {
      if (s.type === "inbound-rtp" && s.kind === "video") frames += s.framesDecoded || 0;
    });
  }
  return { frames, pcs: pcs.length };
})()`;

/** Every peer connection on the page has been closed (torn down, not idle). */
const ALL_PCS_CLOSED = `(() => (window.__b0pcs || []).every(
  (pc) => pc.signalingState === "closed" || pc.connectionState === "closed"
))()`;

const pcCount = (page: Page) =>
  page.evaluate(`(window.__b0pcs || []).length`) as Promise<number>;

/** Wait for decoded frames on connections built after `from`, climbing. */
async function decodesAgain(
  page: Page,
  from: number,
  label: string,
): Promise<boolean> {
  const first = await until(
    label,
    async () => {
      const s: any = await page.evaluate(framesSince(from));
      return s && s.frames > 0 ? s : null;
    },
    60_000,
  );
  if (!first) return false;
  await new Promise((r) => setTimeout(r, 2000));
  const next: any = await page.evaluate(framesSince(from));
  return next.frames > (first as any).frames;
}

/** Wait for a visible button by accessible name, then click it. */
async function press(
  page: Page,
  name: RegExp,
  label: string,
  timeoutMs = 20_000,
): Promise<boolean> {
  const button = page.getByRole("button", { name });
  const ok = await until(
    label,
    async () =>
      (await button.count()) > 0 &&
      (await button.first().isVisible()) &&
      (await button.first().isEnabled()),
    timeoutMs,
  );
  if (!ok) return false;
  await button.first().click();
  return true;
}

const hasText = async (page: Page, re: RegExp) =>
  (await page.getByText(re).count()) > 0;

/** The event's End stamp, read from the database rather than any UI. */
async function liveEndedAt(eventId: string): Promise<string | null> {
  const res = await fetch(
    `${url}/rest/v1/events?id=eq.${eventId}&select=live_ended_at`,
    { headers: adm },
  );
  const rows = (await res.json()) as { live_ended_at: string | null }[];
  return rows[0]?.live_ended_at ?? null;
}

// --- the test ---------------------------------------------------------------
async function main() {
  console.log(`\nwebinar-e2e — provider: ${PROVIDER}\n`);

  const health = await fetch(BASE).catch(() => null);
  if (!health?.ok) {
    console.error(`No dev server at ${BASE}. Run \`npm run dev\` first.`);
    process.exit(1);
  }

  // Say out loud which database is about to get real rows written to it. BASE
  // is the APP; the accounts and the public test event go wherever .env.local
  // points, which is very often production even when BASE is localhost. That
  // mismatch is exactly why this names the project ref rather than BASE.
  if (!/localhost|127\.0\.0\.1/.test(url)) {
    console.log(`  !!  writing test rows to Supabase project ${projectRef}`);
    console.log(`  !!  a public test event exists for the duration of this run\n`);
  }

  // Anything a previous run left behind, before this one adds more.
  await reapOrphans();

  console.log("fixtures");
  const hostUserId = await createUser(HOST_EMAIL, "admin");
  const viewerUserId = await createUser(VIEWER_EMAIL, "student");
  const mentorUserId = await createUser(MENTOR_EMAIL, "mentor");
  const eventId = await createLiveWebinar();
  pass(`admin + mentor + student accounts, and a webinar that is live now`);
  info(`event ${eventId}`);

  // The webinar host is an ADMIN, and nothing else — not a speaker row, not an
  // events.manage custom role. An admin being shown the viewer's page is the
  // bug this proves gone, so read the role back rather than trusting the PATCH.
  const roleRes = await fetch(
    `${url}/rest/v1/profiles?id=eq.${hostUserId}&select=role`,
    { headers: adm },
  );
  const roleRows = (await roleRes.json()) as { role: string }[];
  check(roleRows[0]?.role === "admin", "the webinar host's profile role is 'admin'");

  let browser: Browser | null = null;
  const contexts: BrowserContext[] = [];

  try {
    browser = await chromium.launch({
      headless: !headed,
      args: [
        // A moving test pattern and a tone, so decoded frames climb.
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
        "--autoplay-policy=no-user-gesture-required",
      ],
    });

    const live = `/dashboard/events/${eventId}/live`;

    // --- host starts ------------------------------------------------------
    console.log("\nhost");
    const host = await openAs(browser, HOST_EMAIL, live, "host");
    contexts.push(host.ctx);
    check(await enterRoom(host.page, "host"), "host reached the green room and started");

    const hosting = await until("host to be hosting", async () =>
      (await host.page.getByText(/hosting/i).count()) > 0,
    );
    check(!!hosting, "the ADMIN is in the room as host, broadcasting");

    // --- viewer joins ------------------------------------------------------
    console.log("\nviewer");
    const viewer = await openAs(browser, VIEWER_EMAIL, live, "viewer");
    contexts.push(viewer.ctx);
    check(await enterRoom(viewer.page, "viewer"), "viewer reached the green room and joined");

    const watching = await until("viewer to be watching", async () =>
      (await viewer.page.getByText(/watching/i).count()) > 0,
    );
    check(!!watching, "viewer is in the room");

    // --- THE assertion -----------------------------------------------------
    console.log("\nmedia");
    const first = await until(
      "viewer to decode the host's video",
      async () => {
        const s: any = await viewer.page.evaluate(INBOUND_FRAMES);
        return s && s.frames > 0 ? s : null;
      },
      60_000,
    );
    check(!!first, "viewer decodes the host's video (the whole point)");
    if (!first) {
      // Where exactly did it stall? The peer-connection states on both sides
      // separate "the offer never arrived" from "ICE never completed", which
      // are entirely different bugs.
      const probe = `(() => (window.__b0pcs || []).map((pc) => ({
        signaling: pc.signalingState,
        conn: pc.connectionState,
        ice: pc.iceConnectionState,
        gather: pc.iceGatheringState,
        senders: pc.getSenders().filter((s) => s.track).length,
        receivers: pc.getReceivers().filter((r) => r.track).length,
      })))()`;
      info(`host pcs:   ${JSON.stringify(await host.page.evaluate(probe))}`);
      info(`viewer pcs: ${JSON.stringify(await viewer.page.evaluate(probe))}`);
    }
    if (first) {
      info(
        `${(first as any).pcs} peer connection(s), ${(first as any).frames} frames, ${(first as any).bytes} bytes`,
      );
    }

    if (first) {
      await new Promise((r) => setTimeout(r, 3000));
      const second: any = await viewer.page.evaluate(INBOUND_FRAMES);
      check(
        second.frames > (first as any).frames,
        "video keeps arriving (frame count climbs — not a frozen first frame)",
      );
      info(
        `+${second.frames - (first as any).frames} frames in 3s`,
      );
      check(second.audio > 0, "viewer receives the host's audio");
    }

    // --- the guarantees that make it a webinar -----------------------------
    console.log("\nwebinar guarantees");
    const viewerBody =
      (await viewer.page.locator("body").innerText().catch(() => "")) || "";

    // The audience count is the single number a webinar exists to withhold.
    const leaked = /\d+\s+watching/i.exec(viewerBody);
    check(!leaked, "viewer is shown NO audience count");
    if (leaked) {
      info(`viewer page leaked: "${leaked[0]}"`);
      info(`viewer body: ${viewerBody.slice(0, 400).replace(/\s+/g, " ")}`);
    }

    // A viewer has no camera or mic controls at all — not disabled ones.
    const micButtons = await viewer.page
      .getByRole("button", { name: /microphone/i })
      .count();
    const camButtons = await viewer.page
      .getByRole("button", { name: /camera/i })
      .count();
    check(
      micButtons === 0 && camButtons === 0,
      "viewer has no camera or mic controls",
    );

    // And nothing outbound on the wire, whatever the UI shows.
    const outbound: any = await viewer.page.evaluate(`(async () => {
      const pcs = window.__b0pcs || [];
      let sending = 0;
      for (const pc of pcs) {
        let report; try { report = await pc.getStats(); } catch { continue; }
        report.forEach((s) => {
          if (s.type === "outbound-rtp" && (s.bytesSent || 0) > 0) sending++;
        });
      }
      return { sending };
    })()`);
    check(
      outbound.sending === 0,
      "viewer sends no media at all (recvonly holds on the wire)",
    );

    // The host, by contrast, must see the audience — this is the thing the
    // Daily setup could NOT do, because hasPresence:false hid viewers from
    // the host too, leaving nobody able to tell if anyone was watching.
    const sawAudience = await until("host to count the audience", async () => {
      const body = (await host.page.locator("body").innerText()) || "";
      return /\d+\s+watching/i.test(body);
    }, 30_000);
    check(!!sawAudience, "host DOES see a headcount of the audience");

    // --- layout truthfulness ----------------------------------------------
    //
    // All three transceivers (camera, screen, audio) exist from the first
    // offer, so `ontrack` fires for the screen slot even when nobody is
    // presenting. Treating "a track object exists" as "they are presenting"
    // put every viewer into the presenting layout, staring at a black
    // rectangle where the host's face should be — and a decoded-frames check
    // passes right through it, which is exactly why this assertion exists.
    const presenting = await viewer.page.getByText(/presenting/i).count();
    check(
      presenting === 0,
      "viewer is NOT shown a 'presenting' tile when nobody is presenting",
    );

    // --- a second student: the real test of the star topology -------------
    //
    // One viewer proves media flows. TWO prove the shape is right: the host
    // must hold a separate connection per student, each student must hold
    // exactly one (to the host), and neither may discover the other. A mesh
    // implementation passes every check above and fails here.
    console.log("\nsecond student");
    const viewer2Email = `e2e-webinar-viewer2-${stamp}@example.invalid`;
    await createUser(viewer2Email, "student");
    const viewer2 = await openAs(browser, viewer2Email, live, "viewer2");
    contexts.push(viewer2.ctx);
    check(
      await enterRoom(viewer2.page, "viewer2"),
      "second student joined the same webinar",
    );

    const secondSees = await until(
      "second student to decode video",
      async () => {
        const s: any = await viewer2.page.evaluate(INBOUND_FRAMES);
        return s && s.frames > 0 ? s : null;
      },
      60_000,
    );
    check(!!secondSees, "second student also decodes the host's video");

    // Each student holds exactly one peer connection — to the host. If they
    // were being introduced to each other, this would be two.
    const v1pcs: any = await viewer.page.evaluate(
      `(window.__b0pcs || []).length`,
    );
    const v2pcs: any = await viewer2.page.evaluate(
      `(window.__b0pcs || []).length`,
    );
    check(
      v1pcs === 1 && v2pcs === 1,
      "each student holds exactly ONE connection — to the host, never to each other",
    );
    info(`student A: ${v1pcs} connection(s), student B: ${v2pcs}`);

    // And the host holds one per student: a star, not a mesh.
    const hostPcs: any = await host.page.evaluate(
      `(window.__b0pcs || []).length`,
    );
    check(hostPcs === 2, "host holds one connection per student (a star)");
    info(`host: ${hostPcs} connection(s)`);

    // Neither student's page may contain the other's name anywhere.
    const v1body = (await viewer.page.locator("body").innerText()) || "";
    const v2body = (await viewer2.page.locator("body").innerText()) || "";
    check(
      !v1body.includes("E2E Student") || v1body.indexOf("E2E Student") === v1body.lastIndexOf("E2E Student"),
      "student A's page does not list the other student",
    );
    check(
      !/\d+\s+watching/i.test(v2body),
      "second student is also shown no audience count",
    );

    // The host's headcount must now read 2 — proving the count is real and
    // not a placeholder that happened to be non-zero.
    const countsTwo = await until("host count to reach 2", async () => {
      const body = (await host.page.locator("body").innerText()) || "";
      return /2\s+watching/i.test(body);
    }, 30_000);
    check(!!countsTwo, "host's headcount reflects BOTH students");

    // --- camera off must read as "camera off", not as a black frame -------
    //
    // A disabled track still transmits (black frames), so a viewer would see
    // a frozen picture rather than being told. The engine detaches the track
    // instead, which mutes the receiver's and lets the UI say so.
    console.log("\nhost turns the camera off");
    await host.page
      .getByRole("button", { name: /turn camera off/i })
      .first()
      .click();
    const toldCameraOff = await until(
      "viewer to be told the camera is off",
      async () =>
        (await viewer.page.getByText(/camera is off/i).count()) > 0 ||
        (await viewer.page.getByText(/camera off/i).count()) > 0,
      25_000,
    );
    check(!!toldCameraOff, "viewer is TOLD the camera is off (not shown black)");

    // Audio must keep flowing — talking with the camera off is normal.
    const stillHears: any = await viewer.page.evaluate(INBOUND_FRAMES);
    check(stillHears.audio > 0, "audio keeps flowing while the camera is off");

    await host.page
      .getByRole("button", { name: /turn camera on/i })
      .first()
      .click();
    const cameraBack = await until(
      "video to come back",
      async () => {
        const before: any = await viewer.page.evaluate(INBOUND_FRAMES);
        await new Promise((r) => setTimeout(r, 1500));
        const after: any = await viewer.page.evaluate(INBOUND_FRAMES);
        return after.frames > before.frames ? after : null;
      },
      30_000,
    );
    check(!!cameraBack, "video resumes when the camera comes back on");

    // --- Leave, then Rejoin --------------------------------------------------
    //
    // Leave means "I go; the room keeps running". It used to leave the viewer
    // on a "You've left" screen whose Rejoin did nothing until a reload.
    console.log("\nviewer leaves and rejoins");
    check(
      await press(viewer.page, /^leave$/i, "viewer's Leave button"),
      "viewer pressed Leave",
    );
    const leftScreen = await until(
      "viewer's left screen",
      async () => hasText(viewer.page, /you.ve left/i),
      15_000,
    );
    check(!!leftScreen, "viewer sees \"You've left\"");
    const leftClosed = await until(
      "viewer's connections to close",
      async () => (await viewer.page.evaluate(ALL_PCS_CLOSED)) as boolean,
      10_000,
    );
    check(!!leftClosed, "leaving closes the viewer's connection (no media after Leave)");

    // The room kept running for everyone else: the host's count drops to the
    // one student still watching rather than holding a ghost.
    const countsOne = await until("host count to drop to 1", async () => {
      const body = (await host.page.locator("body").innerText()) || "";
      return /(^|\D)1\s+watching/i.test(body);
    }, 30_000);
    check(!!countsOne, "host's headcount drops when a viewer leaves");

    const beforeRejoin = await pcCount(viewer.page);
    check(
      await press(viewer.page, /^rejoin$/i, "viewer's Rejoin button"),
      "viewer pressed Rejoin",
    );
    check(
      await enterRoom(viewer.page, "viewer rejoin"),
      "Rejoin goes back through the green room",
    );
    check(
      await decodesAgain(viewer.page, beforeRejoin, "rejoined viewer to decode video"),
      "rejoined viewer decodes the host's video again, on a fresh connection",
    );

    // --- End for everyone ----------------------------------------------------
    //
    // One control, two steps, and it must reach every viewer: not by the
    // viewer's next 8s poll alone but by the stage hint, and in every case
    // well inside ~15s. After it, the room is shut: no media, no rejoin, no
    // fresh join.
    console.log("\nhost ends the webinar for everyone");
    const viewerPcsAtEnd = await pcCount(viewer.page);
    check(
      await press(host.page, /^end for everyone$/i, "host's End for everyone"),
      "host armed End for everyone",
    );
    check(
      await press(host.page, /^confirm end$/i, "End confirm step", 5_000),
      "host confirmed the end",
    );
    const endPressedAt = Date.now();

    const viewerEnded = await until(
      "viewer's ended screen",
      async () => hasText(viewer.page, /this webinar has ended/i),
      15_000,
    );
    check(!!viewerEnded, "viewer is moved to \"This webinar has ended\" within 15s");
    if (viewerEnded) info(`reached the viewer in ${Date.now() - endPressedAt}ms`);

    const viewer2Ended = await until(
      "second student's ended screen",
      async () => hasText(viewer2.page, /this webinar has ended/i),
      15_000,
    );
    check(!!viewer2Ended, "the second student sees it too");

    const hostEnded = await until(
      "host's ended screen",
      async () => hasText(host.page, /you ended the webinar for everyone/i),
      20_000,
    );
    check(!!hostEnded, "host lands on the ended screen");
    check(!!(await liveEndedAt(eventId)), "live_ended_at is stamped in the database");

    const endedClosed = await until(
      "viewer's connections to close after End",
      async () => (await viewer.page.evaluate(ALL_PCS_CLOSED)) as boolean,
      10_000,
    );
    check(!!endedClosed, "End closes the viewer's connections");
    const frozenA: any = await viewer.page.evaluate(INBOUND_FRAMES);
    await new Promise((r) => setTimeout(r, 3000));
    const frozenB: any = await viewer.page.evaluate(INBOUND_FRAMES);
    check(
      frozenB.frames <= frozenA.frames,
      "viewer stops receiving frames after End",
    );
    check(
      (await pcCount(viewer.page)) === viewerPcsAtEnd,
      "nothing reconnects the viewer on its own after End",
    );
    check(
      (await viewer.page.getByRole("button", { name: /^rejoin$/i }).count()) === 0,
      "the viewer's ended screen offers no Rejoin while the webinar is ended",
    );

    // A fresh join — a new tab, a reload — is refused, by the page itself.
    const late = await openAs(browser, VIEWER_EMAIL, live, "late viewer");
    contexts.push(late.ctx);
    const lateRefused = await until(
      "late viewer to be refused",
      async () => hasText(late.page, /this webinar has ended/i),
      30_000,
    );
    check(!!lateRefused, "a fresh viewer join after End is shown the ended page");
    check(
      (await late.page.getByRole("button", { name: /^(join|start)$/i }).count()) === 0,
      "and there is no Join button to press",
    );

    // --- Reopen ------------------------------------------------------------
    //
    // Staff only, on the ended screen. Reopen alone puts nobody on air: the
    // host goes back through the green room and presses Start.
    console.log("\nhost reopens");
    check(
      await press(host.page, /^reopen$/i, "host's Reopen button"),
      "host pressed Reopen",
    );
    const cleared = await until(
      "live_ended_at to clear",
      async () => (await liveEndedAt(eventId)) === null,
      15_000,
    );
    check(!!cleared, "Reopen clears live_ended_at");
    check(
      await enterRoom(host.page, "host after reopen"),
      "host is back in the green room and starts again",
    );
    // The in-room "Hosting" chip exactly — the green room's "You're hosting —
    // your camera…" copy must not pass for being on air.
    const hostingAgain = await until("host to be hosting again", async () =>
      hasText(host.page, /^\s*hosting\s*$/i),
    );
    check(!!hostingAgain, "host is broadcasting again");

    // The ended viewer is not reconnected behind their back; their ended
    // screen polls every 30s and offers Rejoin once the webinar is open.
    const beforeReopenRejoin = await pcCount(viewer.page);
    check(
      await press(
        viewer.page,
        /^rejoin$/i,
        "ended viewer to be offered Rejoin",
        45_000,
      ),
      "the ended viewer is offered Rejoin after Reopen, and pressed it",
    );
    check(
      await enterRoom(viewer.page, "viewer after reopen"),
      "viewer goes back through the green room",
    );
    check(
      await decodesAgain(
        viewer.page,
        beforeReopenRejoin,
        "viewer to decode video after Reopen",
      ),
      "after Reopen the viewer decodes the host's video again",
    );

    // --- 1:1 calls: the other shape the same engine has to run ------------
    //
    // A 1:1 is two BROADCASTERS, which exercises code a webinar never
    // touches: sendrecv transceivers on both sides, and the id-comparison
    // tie-break that decides which of them offers. A webinar passing proves
    // nothing about this path.
    //
    // The owner is a MENTOR, not an admin: live rooms sit under /dashboard,
    // and a mentor used to be bounced out of the room they were hosting by
    // the student-dashboard role gate.
    console.log("\n1:1 call (mentor host)");
    const inviteId = await createAcceptedCall(mentorUserId, viewerUserId);
    const callPath = `/dashboard/calls/${inviteId}/live`;

    // Every 1:1 is recorded, and both people are told so in the green room —
    // BEFORE the Join button, not once they are already on camera.
    const recordedNotice = /this call is recorded/i;

    const caller = await openAs(browser, MENTOR_EMAIL, callPath, "caller");
    contexts.push(caller.ctx);
    check(
      !!(await until("the mentor's recording notice", async () =>
        hasText(caller.page, recordedNotice),
      )),
      "the mentor is told the call is recorded before joining",
    );
    check(await enterRoom(caller.page, "caller"), "the mentor opened the 1:1");

    const callee = await openAs(browser, VIEWER_EMAIL, callPath, "callee");
    contexts.push(callee.ctx);
    check(
      !!(await until("the student's recording notice", async () =>
        hasText(callee.page, recordedNotice),
      )),
      "the student is told the call is recorded before joining",
    );
    check(await enterRoom(callee.page, "callee"), "student opened the same 1:1");

    // Both directions must carry media — that is what makes it a call rather
    // than a broadcast.
    const callerSees = await until(
      "host to decode the student's video",
      async () => {
        const s: any = await caller.page.evaluate(INBOUND_FRAMES);
        return s && s.frames > 0 ? s : null;
      },
      60_000,
    );
    const calleeSees = await until(
      "student to decode the host's video",
      async () => {
        const s: any = await callee.page.evaluate(INBOUND_FRAMES);
        return s && s.frames > 0 ? s : null;
      },
      60_000,
    );
    // A 1:1 that never connects cascades into every check below; say what
    // each page was showing, as enterRoom does for a green room.
    if (!callerSees || !calleeSees) {
      for (const [label, pg] of [["caller", caller.page], ["callee", callee.page]] as const) {
        const pcs = await pg
          .evaluate(`(window.__b0pcs || []).map((pc) => pc.connectionState + "/" + pc.signalingState).join(", ")`)
          .catch(() => "?");
        const body = (await pg.locator("body").innerText().catch(() => "")) || "";
        info(`[${label}] connections: ${pcs || "none"}; page said: ${body.slice(0, 300).replace(/\s+/g, " ")}`);
      }
    }
    check(!!callerSees, "host decodes the student's video");
    check(!!calleeSees, "student decodes the host's video");

    // And both must be SENDING — in a webinar the student sends nothing, so
    // this is the assertion that proves the role really did differ.
    const bothSending = await until(
      "both sides to be sending",
      async () => {
        const probe = `(async () => {
          let sending = 0;
          for (const pc of (window.__b0pcs || [])) {
            let r; try { r = await pc.getStats(); } catch { continue; }
            r.forEach((s) => {
              if (s.type === "outbound-rtp" && (s.bytesSent || 0) > 0) sending++;
            });
          }
          return sending;
        })()`;
        const a: any = await caller.page.evaluate(probe);
        const b: any = await callee.page.evaluate(probe);
        return a > 0 && b > 0 ? { a, b } : null;
      },
      45_000,
    );
    check(
      !!bothSending,
      "BOTH sides send media (a 1:1 is two broadcasters, not a broadcast)",
    );

    // The mentor's browser is the one recording (call_invites.host_id), and
    // says so in the room.
    const recording = await until("the mentor's Recording indicator", async () =>
      hasText(caller.page, /^\s*recording\s*$/i),
    );
    check(!!recording, "the mentor's room shows it is recording");

    // End call: one press, offered once both people have been in the room and
    // the start has come (the call started two minutes ago). Final for both.
    console.log("\nthe host ends the call");
    check(
      await press(caller.page, /^end call$/i, "the mentor's End call", 30_000),
      "the mentor pressed End call",
    );
    const callEnded = /this call has ended/i;
    // The presser's room shows the ended screen at once, and returns them to
    // their OWN calls page (/mentor/calls, never the student inbox) once the
    // recording's last segment has uploaded.
    const callerDone = await until(
      "the mentor's ended screen or calls page",
      async () =>
        (await hasText(caller.page, callEnded)) ||
        new URL(caller.page.url()).pathname === "/mentor/calls",
      15_000,
    );
    check(!!callerDone, "the mentor sees \"This call has ended\"");
    // The other side learns it from its status poll or its heartbeat.
    const calleeEnded = await until(
      "the student's ended screen",
      async () => hasText(callee.page, callEnded),
      40_000,
    );
    check(!!calleeEnded, "the student's room closes too: \"This call has ended\"");
    const statusRes = await fetch(
      `${url}/rest/v1/call_invites?id=eq.${inviteId}&select=status`,
      { headers: adm },
    );
    const statusRows = (await statusRes.json()) as { status: string }[];
    check(statusRows[0]?.status === "completed", "the call is completed in the database");

    const backHome = await until(
      "the mentor to be sent back to /mentor/calls",
      async () => new URL(caller.page.url()).pathname === "/mentor/calls",
      100_000,
    );
    check(!!backHome, "the mentor lands back on their own calls page");
    const uploaded = await until(
      "the call's recording to land in storage",
      async () => {
        const files = await callRecordingFiles(inviteId);
        return files.length > 0 ? files : null;
      },
      60_000,
    );
    check(
      !!uploaded,
      "the mentor's browser recorded the call and uploaded it after End call",
    );
    if (uploaded) info(`${(uploaded as string[]).length} recording segment(s)`);

    await callee.page.reload({ waitUntil: "domcontentloaded" });
    const calleeRefused = await until(
      "student's reload to be refused",
      async () => hasText(callee.page, callEnded),
      30_000,
    );
    check(!!calleeRefused, "the student cannot walk back into an ended call");

    if (headed) {
      info("--headed: holding the windows open for 20s");
      await new Promise((r) => setTimeout(r, 20_000));
    }
  } finally {
    for (const c of contexts) await c.close().catch(() => {});
    await browser?.close().catch(() => {});
    await cleanup();
    info("test accounts and event removed");
  }

  console.log(
    failures === 0
      ? "\nAll checks passed — a student really does see and hear the host.\n"
      : `\n${failures} check(s) FAILED — see above.\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  await cleanup();
  console.error("\nwebinar-e2e failed:\n", err instanceof Error ? err.stack : err);
  process.exit(1);
});
