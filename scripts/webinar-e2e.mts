/**
 * Webinar end-to-end proof: does a student actually see and hear the host?
 *
 *   npm run dev          # in another terminal
 *   npm run webinar-e2e
 *   npm run webinar-e2e -- --headed    # watch it happen
 *
 * Why this exists
 * ---------------
 * A REST check of the old Daily provider passed for months while hosted
 * webinars were completely broken: rooms and tokens were fine, but the Daily
 * account refused every media session (`account-missing-payment-method`). A
 * REST-shaped check can never see that.
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
 *   - the host shares a screen: a connected viewer and one who joins
 *     MID-SHARE both get it as the main stage, and stopping returns everyone
 *     to the camera; then the host presents the event's PDF deck and a
 *     viewer decodes it as the main stage;
 *   - a chat message the host removes disappears for the other students;
 *   - a second admin is offered "Join as co-host" (the first is hosting),
 *     joins with camera and mic off, and the host's "Pin for everyone" moves
 *     every viewer's main stage to them (and back);
 *   - a viewer presses Leave, lands on "You've left", presses Rejoin and
 *     decodes the host again on a fresh connection;
 *   - the host presses End for everyone (Leave menu, then confirm): every
 *     viewer is moved to "This webinar has ended" within seconds, their
 *     connections close and frames stop, and a fresh join is refused;
 *   - the host presses Reopen, goes back on air, and the ended viewer is
 *     offered Rejoin (the ended screen's slow poll) and decodes video again;
 *   - a cohort webinar three hours out: the host is only rehearsing (the
 *     student waits) until staff press Go live now, which moves the event to
 *     now, lets the waiting student in and rings their bell; the host's tab
 *     records it, and after End the admin event page's "Share with students"
 *     (its email is off) puts "Watch recording" on the student's events
 *     lists and the recording on the event's page;
 *   - the 1:1 is hosted by a MENTOR (the live-room middleware exemption):
 *     both people are shown the recording notice before they join, the
 *     mentor's End call puts both sides on "This call has ended" and marks
 *     the call completed, the mentor lands back on their own calls page, and
 *     the mentor's browser — the side that records — has uploaded the call
 *     as one finished take, whose media route answers 206 with video/webm.
 *
 * Selectors are the room kit's data-testid attributes (components/live/room).
 *
 * Every account, row and stored file it creates is removed in a finally
 * block, including on failure.
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
const HOST_EMAIL = `e2e-webinar-host-${stamp}@example.invalid`;
const VIEWER_EMAIL = `e2e-webinar-viewer-${stamp}@example.invalid`;
const MENTOR_EMAIL = `e2e-webinar-mentor-${stamp}@example.invalid`;
const COHOST_EMAIL = `e2e-webinar-cohost-${stamp}@example.invalid`;
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
let createdEarlyEventId: string | null = null;
let createdCohortId: string | null = null;
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
        email === COHOST_EMAIL
          ? "E2E Cohost"
          : role === "admin"
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
      // Chat on, and no recording (the 1:1 below covers recording): said
      // here so the run doesn't depend on the database's column defaults.
      audience_mode: "open",
      auto_record: false,
    }),
  });
  const rows = await res.json();
  if (!res.ok) throw new Error(`createEvent: ${JSON.stringify(rows)}`);
  createdEventId = rows[0].id;
  return rows[0].id;
}

/**
 * A cohort webinar three hours out, for `studentId`'s own (new) cohort:
 * long before its go-live window, so a host in its room is rehearsing. It
 * records automatically and is not emailed afterwards (auto_share off).
 */
async function createScheduledWebinar(studentId: string): Promise<string> {
  const day = 86_400_000;
  const cohortRes = await fetch(`${url}/rest/v1/cohorts`, {
    method: "POST",
    headers: { ...adm, Prefer: "return=representation" },
    body: JSON.stringify({
      name: `E2E webinar cohort ${stamp}`,
      starts_on: new Date(Date.now() - 14 * day).toISOString().slice(0, 10),
      ends_on: new Date(Date.now() + 40 * day).toISOString().slice(0, 10),
      status: "active",
    }),
  });
  const cohorts = await cohortRes.json();
  if (!cohortRes.ok) throw new Error(`createCohort: ${JSON.stringify(cohorts)}`);
  createdCohortId = cohorts[0].id as string;
  const enrol = await fetch(`${url}/rest/v1/enrollments`, {
    method: "POST",
    headers: adm,
    body: JSON.stringify({ user_id: studentId, cohort_id: createdCohortId }),
  });
  if (!enrol.ok) throw new Error(`enroll: ${await enrol.text()}`);
  const start = Date.now() + 3 * 60 * 60_000;
  const res = await fetch(`${url}/rest/v1/events`, {
    method: "POST",
    headers: { ...adm, Prefer: "return=representation" },
    body: JSON.stringify({
      title: `E2E Early ${stamp}`,
      type: "webinar",
      starts_at: new Date(start).toISOString(),
      ends_at: new Date(start + 45 * 60_000).toISOString(),
      visibility: "enrolled",
      cohort_id: createdCohortId,
      live_mode: "hosted",
      audience_mode: "open",
      auto_record: true,
      auto_share: false,
    }),
  });
  const rows = await res.json();
  if (!res.ok) throw new Error(`createScheduledWebinar: ${JSON.stringify(rows)}`);
  createdEarlyEventId = rows[0].id;
  return rows[0].id;
}

/**
 * A small, valid PDF: `pages` slides reading "Slide N". Built by hand (with a
 * correct xref) so the run needs no fixture file.
 */
function makePdf(pages: number): Buffer {
  const objs: string[] = [];
  objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objs[2] = `<< /Type /Pages /Kids [${Array.from({ length: pages }, (_, i) => `${4 + i * 2} 0 R`).join(" ")}] /Count ${pages} >>`;
  objs[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  for (let i = 0; i < pages; i++) {
    const content = `BT /F1 96 Tf 120 240 Td (Slide ${i + 1}) Tj ET`;
    objs[4 + i * 2] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 960 540] ` +
      `/Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`;
    objs[5 + i * 2] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
  }
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let n = 1; n < objs.length; n++) {
    offsets[n] = Buffer.byteLength(out, "latin1");
    out += `${n} 0 obj\n${objs[n]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let n = 1; n < objs.length; n++) out += `${String(offsets[n]).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

/** The event's slide deck: a PDF in webinar-media and its event_assets row. */
async function uploadDeck(eventId: string): Promise<void> {
  const pdf = makePdf(3);
  const path = `${eventId}/deck/e2e-deck.pdf`;
  const up = await fetch(`${url}/storage/v1/object/webinar-media/${path}`, {
    method: "POST",
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/pdf" },
    body: new Uint8Array(pdf),
  });
  if (!up.ok) throw new Error(`uploadDeck: ${await up.text()}`);
  const row = await fetch(`${url}/rest/v1/event_assets`, {
    method: "POST",
    headers: adm,
    body: JSON.stringify({
      event_id: eventId,
      kind: "deck",
      storage_path: path,
      filename: "E2E deck.pdf",
      mime_type: "application/pdf",
      size_bytes: pdf.length,
    }),
  });
  if (!row.ok) throw new Error(`deck row: ${await row.text()}`);
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

// ---- recording (one take per Record → Stop; docs/recording.md) ----------

/** A room's finished takes: closed, finalized, with parts in storage. */
async function finishedTakes(
  kind: "webinar" | "call",
  roomId: string,
): Promise<{ id: string; part_count: number; duration_ms: number }[]> {
  const res = await fetch(
    `${url}/rest/v1/recording_sessions?room_kind=eq.${kind}&room_id=eq.${roomId}` +
      `&status=eq.finished&finalized_at=not.is.null&part_count=gt.0&select=id,part_count,duration_ms`,
    { headers: adm },
  ).catch(() => null);
  if (!res?.ok) return [];
  return (await res.json()) as { id: string; part_count: number; duration_ms: number }[];
}

/** Every take of a room, rows and bytes. */
async function removeRecordings(kind: "webinar" | "call", roomId: string): Promise<void> {
  await removeStoragePrefix("recordings", `${kind}/${roomId}`);
  await fetch(`${url}/rest/v1/recording_sessions?room_kind=eq.${kind}&room_id=eq.${roomId}`, {
    method: "DELETE",
    headers: adm,
  }).catch(() => {});
}
// ---- end recording ----------------------------------------------------------

async function cleanup() {
  // Recordings first: the 1:1 is recorded (recording_sessions rows + parts in
  // the private recordings bucket). The test webinar turns auto-record off,
  // but a recording of test accounts must never be left behind.
  if (createdInviteId) await removeRecordings("call", createdInviteId);
  if (createdEventId) await removeRecordings("webinar", createdEventId);
  if (createdEarlyEventId) await removeRecordings("webinar", createdEarlyEventId);
  if (createdEventId) {
    await fetch(`${url}/rest/v1/event_assets?event_id=eq.${createdEventId}`, {
      method: "DELETE",
      headers: adm,
    }).catch(() => {});
    await removeStoragePrefix("webinar-media", createdEventId);
  }
  // End / Reopen / Go live now / Share / End call write audit entries against
  // the test events and call. They name only these throwaway rows, so they go
  // with them.
  for (const target of [createdEventId, createdEarlyEventId, createdInviteId]) {
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
  for (const eventId of [createdEventId, createdEarlyEventId]) {
    if (!eventId) continue;
    await fetch(`${url}/rest/v1/live_participants?event_id=eq.${eventId}`, {
      method: "DELETE",
      headers: adm,
    }).catch(() => {});
    await fetch(`${url}/rest/v1/events?id=eq.${eventId}`, {
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
  // After the accounts, whose enrollments in it go with them.
  if (createdCohortId) {
    await fetch(`${url}/rest/v1/cohorts?id=eq.${createdCohortId}`, {
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

// --- screen share (fake) ---------------------------------------------------
/**
 * A deterministic "screen" for the host: getDisplayMedia answers with a
 * moving canvas instead of a picker, so a headless run can share. The app
 * cannot tell the difference — any video track can fill the screen slot.
 */
const FAKE_DISPLAY = `
if (navigator.mediaDevices) {
  navigator.mediaDevices.getDisplayMedia = async () => {
    const c = document.createElement("canvas");
    c.width = 1280; c.height = 720;
    const g = c.getContext("2d");
    let n = 0;
    setInterval(() => {
      g.fillStyle = n % 2 ? "#123456" : "#654321";
      g.fillRect(0, 0, c.width, c.height);
      g.fillStyle = "#fff";
      g.font = "72px sans-serif";
      g.fillText("slide " + n++, 80, 200);
    }, 100);
    return c.captureStream(10);
  };
}
`;

/** Decoded frames on the SCREEN slot (mid 1) of connections built after `from`. */
const screenFramesSince = (from: number) => `(async () => {
  let frames = 0;
  for (const pc of (window.__b0pcs || []).slice(${from})) {
    let report;
    try { report = await pc.getStats(); } catch { continue; }
    report.forEach((s) => {
      if (s.type === "inbound-rtp" && s.kind === "video" && s.mid === "1") {
        frames += s.framesDecoded || 0;
      }
    });
  }
  return frames;
})()`;

async function openAs(
  browser: Browser,
  email: string,
  path: string,
  label: string,
  initScript?: string,
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
  if (initScript) await ctx.addInitScript(initScript);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => info(`[${label}] page error: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") info(`[${label}] console: ${m.text().slice(0, 200)}`);
  });
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

/** Click the green room's join button, whatever it is labelled. */
async function enterRoom(page: Page, label: string): Promise<boolean> {
  // "Start webinar" / "Join as co-host" (webinar hosts), "Join" (viewer),
  // "Join call" (either side of a 1:1): one test id.
  const button = page.getByTestId("green-room-join");
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
  let pressedAt = Date.now();
  let presses = 1;
  // The press must actually take: the green room goes away (or the button
  // turns into "Connecting…"). A press that lands before hydration used to
  // be swallowed silently and the whole room section timed out behind it.
  // A webinar host's Join re-reads who is hosting first; when that changed
  // (someone went live or started recording since the last poll) the green
  // room stays to show it, and the button is pressed again.
  const left = await until(
    `${label} to leave the green room`,
    async () => {
      if ((await button.count()) === 0 || !(await button.first().isVisible())) return true;
      const again =
        presses < 3 &&
        Date.now() - pressedAt > 2_000 &&
        (await button.first().isEnabled().catch(() => false)) &&
        !/connecting/i.test((await button.first().innerText().catch(() => "")) || "");
      if (again) {
        info(`[${label}] still in the green room (now "${await button.first().innerText().catch(() => "")}"); pressing again`);
        await button.first().click().catch(() => {});
        pressedAt = Date.now();
        presses++;
      }
      return false;
    },
    20_000,
  );
  if (!left) {
    info(`[${label}] still in the green room after pressing join`);
    return false;
  }
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

/** Peer connections still open on the page. */
const OPEN_PCS = `(() => (window.__b0pcs || []).filter(
  (pc) => pc.signalingState !== "closed" && pc.connectionState !== "closed"
).length)()`;

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

/** Wait for a visible, enabled element by test id, then click it. */
async function tap(
  page: Page,
  testId: string,
  label: string,
  timeoutMs = 20_000,
): Promise<boolean> {
  const el = page.getByTestId(testId);
  const ok = await until(
    label,
    async () =>
      (await el.count()) > 0 &&
      (await el.first().isVisible()) &&
      (await el.first().isEnabled()),
    timeoutMs,
  );
  if (!ok) return false;
  await el.first().click();
  return true;
}

/** What the main stage shows: whose tile, camera or presentation. */
async function mainTile(page: Page): Promise<{ peer: string | null; kind: string | null } | null> {
  const tile = page.locator('[data-testid="tile-main"]');
  if ((await tile.count()) === 0) return null;
  return {
    peer: await tile.first().getAttribute("data-peer"),
    kind: await tile.first().getAttribute("data-kind"),
  };
}

const count = (page: Page, testId: string) => page.getByTestId(testId).count();

/** The host's headcount, from its badge (null when there is none). */
async function audience(page: Page): Promise<number | null> {
  const badge = page.getByTestId("badge-audience");
  if ((await badge.count()) === 0) return null;
  const m = /\d+/.exec((await badge.first().innerText()) || "");
  return m ? Number(m[0]) : null;
}

const hasText = async (page: Page, re: RegExp) =>
  (await page.getByText(re).count()) > 0;

/** An event's run stamps and schedule, read from the database. */
async function eventRow(eventId: string): Promise<Record<string, string | null> | null> {
  const res = await fetch(
    `${url}/rest/v1/events?id=eq.${eventId}&select=starts_at,ends_at,live_started_at,live_ended_at,assets_shared_at`,
    { headers: adm },
  );
  const rows = (await res.json()) as Record<string, string | null>[];
  return rows[0] ?? null;
}

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
  console.log("\nwebinar-e2e\n");

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
  const cohostUserId = await createUser(COHOST_EMAIL, "admin");
  const eventId = await createLiveWebinar();
  await uploadDeck(eventId);
  pass(`two admins + mentor + student accounts, and a webinar that is live now, with a PDF deck`);
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
    const host = await openAs(browser, HOST_EMAIL, live, "host", FAKE_DISPLAY);
    contexts.push(host.ctx);
    check(await enterRoom(host.page, "host"), "host reached the green room and started");

    const hosting = await until(
      "host to be hosting",
      async () =>
        (await count(host.page, "stage")) > 0 &&
        (await host.page.getByText(/^\s*hosting\s*$/i).count()) > 0,
    );
    check(!!hosting, "the ADMIN is in the room as host, broadcasting");

    // --- viewer joins ------------------------------------------------------
    console.log("\nviewer");
    const viewer = await openAs(browser, VIEWER_EMAIL, live, "viewer");
    contexts.push(viewer.ctx);
    check(await enterRoom(viewer.page, "viewer"), "viewer reached the green room and joined");

    const watching = await until(
      "viewer to be watching",
      async () =>
        (await count(viewer.page, "stage")) > 0 &&
        (await viewer.page.getByText(/^\s*watching\s*$/i).count()) > 0,
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
    const leaked =
      (await count(viewer.page, "badge-audience")) > 0 ||
      (await viewer.page.getByText(/\d+\s+watching/i).count()) > 0;
    check(!leaked, "viewer is shown NO audience count");
    if (leaked) info(`viewer body: ${viewerBody.slice(0, 400).replace(/\s+/g, " ")}`);

    // A viewer has no camera or mic controls at all — not disabled ones.
    const micButtons = await viewer.page
      .getByRole("button", { name: /microphone/i })
      .count();
    const camButtons = await viewer.page
      .getByRole("button", { name: /camera/i })
      .count();
    check(
      micButtons === 0 &&
        camButtons === 0 &&
        (await count(viewer.page, "ctrl-mic")) === 0 &&
        (await count(viewer.page, "ctrl-camera")) === 0,
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
    const sawAudience = await until(
      "host to count the audience",
      async () => (await audience(host.page)) !== null,
      30_000,
    );
    check(!!sawAudience, "host DOES see a headcount of the audience");

    // --- layout truthfulness ----------------------------------------------
    //
    // All three transceivers (camera, screen, audio) exist from the first
    // offer, so `ontrack` fires for the screen slot even when nobody is
    // presenting. Treating "a track object exists" as "they are presenting"
    // put every viewer into the presenting layout, staring at a black
    // rectangle where the host's face should be — and a decoded-frames check
    // passes right through it, which is exactly why this assertion exists.
    const presenting =
      (await viewer.page.getByText(/presenting/i).count()) +
      (await viewer.page.locator('[data-kind="presentation"]').count());
    check(
      presenting === 0,
      "viewer is NOT shown a 'presenting' tile when nobody is presenting",
    );
    const firstMain = await mainTile(viewer.page);
    check(
      firstMain?.peer === hostUserId && firstMain.kind === "camera",
      "the viewer's main stage is the host's camera",
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
    // were being introduced to each other, this would be two. "Holds" is the
    // connections still open: a link rebuilt after a stuck negotiation closes
    // the old one first (the total built is logged).
    const v1pcs: any = await viewer.page.evaluate(OPEN_PCS);
    const v2pcs: any = await viewer2.page.evaluate(OPEN_PCS);
    check(
      v1pcs === 1 && v2pcs === 1,
      "each student holds exactly ONE connection — to the host, never to each other",
    );
    info(
      `student A: ${v1pcs} connection(s) (${await pcCount(viewer.page)} built), ` +
        `student B: ${v2pcs} (${await pcCount(viewer2.page)} built)`,
    );

    // And the host holds one per student: a star, not a mesh.
    const hostPcs: any = await host.page.evaluate(OPEN_PCS);
    check(hostPcs === 2, "host holds one connection per student (a star)");
    info(`host: ${hostPcs} connection(s) (${await pcCount(host.page)} built)`);

    // Neither student's page may contain the other's name anywhere.
    const v1body = (await viewer.page.locator("body").innerText()) || "";
    const v2body = (await viewer2.page.locator("body").innerText()) || "";
    check(
      !v1body.includes("E2E Student") || v1body.indexOf("E2E Student") === v1body.lastIndexOf("E2E Student"),
      "student A's page does not list the other student",
    );
    check(
      (await count(viewer2.page, "badge-audience")) === 0,
      "second student is also shown no audience count",
    );

    // The host's headcount must now read 2 — proving the count is real and
    // not a placeholder that happened to be non-zero.
    const countsTwo = await until(
      "host count to reach 2",
      async () => (await audience(host.page)) === 2,
      30_000,
    );
    check(!!countsTwo, "host's headcount reflects BOTH students");

    // --- screen share, and a viewer who arrives MID-SHARE ----------------
    //
    // The share's on/off rides on the offer itself (`slots`), because a
    // viewer has no connection to file a separate `media` message under
    // until the offer lands — that message used to be dropped, and anyone
    // who joined or reloaded mid-share watched the host's face instead of
    // the slides until the host happened to toggle something. Screen share is
    // the main thing: it takes the main stage.
    console.log("\nhost shares the screen; a viewer arrives mid-share");
    check(
      (await tap(host.page, "ctrl-present", "host's Present menu")) &&
        (await tap(host.page, "present-screen", "host's Share screen")),
      "host started sharing (a fake capture)",
    );
    const sharedSeen = await until(
      "connected viewer to be shown the share",
      async () => (await mainTile(viewer2.page))?.kind === "presentation",
      20_000,
    );
    check(!!sharedSeen, "a viewer already in the room is shown the share as the main stage");

    await viewer2.page.reload({ waitUntil: "domcontentloaded" });
    check(await enterRoom(viewer2.page, "viewer2 mid-share"), "a viewer joins mid-share");
    check(
      await decodesAgain(viewer2.page, 0, "mid-share viewer to decode video"),
      "the mid-share viewer is connected",
    );
    const midShare = await until(
      "mid-share viewer to be shown the share",
      async () => {
        const m = await mainTile(viewer2.page);
        return m?.kind === "presentation" && m.peer === hostUserId;
      },
      20_000,
    );
    check(!!midShare, "a viewer who joins MID-SHARE sees the screen as the main stage");
    check(
      (await viewer2.page.getByText(/presenting/i).count()) > 0,
      "…labelled as presenting",
    );
    if (!midShare) {
      const pcs = await viewer2.page
        .evaluate(`(window.__b0pcs || []).map((pc) => pc.connectionState).join(", ")`)
        .catch(() => "?");
      const body = (await viewer2.page.locator("body").innerText().catch(() => "")) || "";
      info(`[viewer2] connections: ${pcs || "none"}; page said: ${body.slice(0, 300).replace(/\s+/g, " ")}`);
    }
    const shareA: any = await until(
      "mid-share viewer to decode the screen",
      async () => {
        const n = (await viewer2.page.evaluate(screenFramesSince(0))) as number;
        return n > 0 ? n : null;
      },
      30_000,
    );
    await new Promise((r) => setTimeout(r, 2000));
    const shareB = (await viewer2.page.evaluate(screenFramesSince(0))) as number;
    check(!!shareA && shareB > shareA, "…and decodes it (screen frames climb)");

    check(
      (await tap(host.page, "ctrl-present", "host's Present menu")) &&
        (await tap(host.page, "present-stop", "host's Stop presenting")),
      "host stopped sharing",
    );
    const unshared = await until(
      "viewers to leave the presenting layout",
      async () =>
        (await viewer.page.getByText(/presenting/i).count()) === 0 &&
        (await viewer2.page.getByText(/presenting/i).count()) === 0 &&
        (await mainTile(viewer.page))?.kind === "camera" &&
        (await mainTile(viewer2.page))?.kind === "camera",
      20_000,
    );
    check(!!unshared, "stopping the share takes every viewer back to the camera");
    // --- end screen share ---------------------------------------------------

    // --- the event's PDF deck ------------------------------------------------
    //
    // "Present slides" renders the event's uploaded PDF (signed URL) to a
    // canvas and sends it through the same screen slot: the viewer decodes it
    // as the main stage, and paging on the presenter keeps frames coming.
    console.log("\nhost presents the event's PDF deck");
    check(
      (await tap(host.page, "ctrl-present", "host's Present menu")) &&
        (await tap(host.page, "present-event-deck", "host's Present slides")),
      "host chose the event's deck",
    );
    const deckOpen = await until(
      "the deck to open on the host",
      async () => /1\s*\/\s*3/.test((await host.page.getByTestId("deck-counter").innerText().catch(() => "")) || ""),
      45_000,
    );
    check(!!deckOpen, "the host's presenter view shows slide 1 of 3");
    if (!deckOpen) {
      const body = (await host.page.locator("body").innerText().catch(() => "")) || "";
      info(`[host] page said: ${body.slice(0, 300).replace(/\s+/g, " ")}`);
    }
    const deckMain = await until(
      "viewer to be shown the deck",
      async () => {
        const m = await mainTile(viewer.page);
        return m?.kind === "presentation" && m.peer === hostUserId;
      },
      20_000,
    );
    check(!!deckMain, "the viewer's main stage is the deck");
    const deckA = (await viewer.page.evaluate(screenFramesSince(0))) as number;
    await tap(host.page, "deck-next", "host's Next slide");
    const deckB: any = await until(
      "viewer to decode the deck",
      async () => {
        const n = (await viewer.page.evaluate(screenFramesSince(0))) as number;
        return n > deckA ? n : null;
      },
      20_000,
    );
    check(!!deckB, "the viewer decodes the deck (frames climb)");
    check(
      /2\s*\/\s*3/.test((await host.page.getByTestId("deck-counter").innerText().catch(() => "")) || ""),
      "Next moves the presenter to slide 2",
    );
    check(
      (await tap(host.page, "ctrl-present", "host's Present menu")) &&
        (await tap(host.page, "present-stop", "host's Stop presenting")),
      "host stopped presenting",
    );
    check(
      !!(await until(
        "viewer back on the camera",
        async () => (await mainTile(viewer.page))?.kind === "camera",
        20_000,
      )),
      "stopping the deck takes the viewer back to the camera",
    );
    // --- end deck -------------------------------------------------------------

    // --- chat: a host's Remove reaches everyone ---------------------------------
    console.log("\nchat remove");
    const chatText = `e2e chat ${stamp}`;
    const chatBox = viewer.page.getByRole("textbox", { name: "Chat message" });
    const canChat = await until("viewer's chat box", async () => (await chatBox.count()) > 0, 20_000);
    if (canChat) {
      await chatBox.first().fill(chatText);
      await chatBox.first().press("Enter");
    }
    const chatRow = (page: Page) => page.locator("li[data-message-id]", { hasText: chatText });
    check(
      !!(await until("the other student to see the message", async () => (await chatRow(viewer2.page).count()) > 0, 20_000)),
      "a chat message reaches the other student",
    );
    const onHost = await until("the host to see the message", async () => (await chatRow(host.page).count()) > 0, 20_000);
    if (onHost) {
      await chatRow(host.page).first().hover();
      await chatRow(host.page).first().getByRole("button", { name: "Remove", exact: true }).click();
    }
    check(
      !!onHost &&
        !!(await until(
          "the message to disappear for both students",
          async () => (await chatRow(viewer2.page).count()) === 0 && (await chatRow(viewer.page).count()) === 0,
          15_000,
        )),
      "the host's Remove takes it away for the other students",
    );

    // --- a second admin: co-host, and Pin for everyone --------------------------
    //
    // Someone is hosting, so the green room offers "Join as co-host" (camera
    // and mic off), not "Start webinar". Staff can pin any host for everyone:
    // that host becomes primary and every viewer's main stage follows.
    console.log("\na second admin joins as co-host; Pin for everyone");
    const cohost = await openAs(browser, COHOST_EMAIL, live, "cohost");
    contexts.push(cohost.ctx);
    const cta = await until(
      "the co-host's green room to say someone is hosting",
      async () =>
        (await cohost.page.getByTestId("green-room").getAttribute("data-cta").catch(() => null)) === "Join as co-host" &&
        /E2E Host is hosting/.test((await cohost.page.getByTestId("green-room-hosting").innerText().catch(() => "")) || ""),
      45_000,
    );
    check(!!cta, "a second admin sees 'Join as co-host' and that E2E Host is hosting");
    check(await enterRoom(cohost.page, "cohost"), "the second admin joined as co-host");
    const mutedIn = await until(
      "the co-host's camera and mic to be off",
      async () =>
        (await cohost.page.getByTestId("ctrl-camera").getAttribute("aria-pressed")) === "true" &&
        (await cohost.page.getByTestId("ctrl-mic").getAttribute("aria-pressed")) === "true",
      30_000,
    );
    check(!!mutedIn, "a co-host joins with camera and mic off");

    const cohostTile = host.page.locator(`[data-peer="${cohostUserId}"][data-kind="camera"]`);
    const onHostStage = await until(
      "the host to see the co-host",
      async () => (await cohostTile.count()) > 0,
      45_000,
    );
    // The viewer has the co-host on stage (a thumbnail) before the pin, so
    // what follows measures the pin, not the link coming up.
    check(
      !!(await until(
        "the viewer to have the co-host on stage",
        async () => (await viewer.page.locator(`[data-peer="${cohostUserId}"]`).count()) > 0,
        45_000,
      )),
      "the viewer sees the co-host join the stage",
    );
    if (onHostStage) {
      await cohostTile.first().hover();
      await cohostTile.first().getByTestId("tile-pin-everyone").click();
    }
    const pinned = await until(
      "the viewer's main stage to move to the co-host",
      async () => (await mainTile(viewer.page))?.peer === cohostUserId,
      20_000,
    );
    check(!!onHostStage && !!pinned, "'Pin for everyone' moves the viewer's main stage to that host");
    if (!pinned) {
      const tiles = `(() => [...document.querySelectorAll('[data-peer]')].map((t) => t.getAttribute('data-testid') + ':' + t.getAttribute('data-peer') + ':' + t.getAttribute('data-kind')).join(' '))()`;
      const pcs = `(() => (window.__b0pcs || []).map((pc) => pc.connectionState).join(','))()`;
      info(`co-host ${cohostUserId}, host ${hostUserId}`);
      info(`viewer tiles: ${await viewer.page.evaluate(tiles)}; links: ${await viewer.page.evaluate(pcs)}`);
      info(`host tiles: ${await host.page.evaluate(tiles)}`);
    }
    const primaryRes = await fetch(`${url}/rest/v1/events?id=eq.${eventId}&select=live_primary_host_id`, { headers: adm });
    const primaryRows = (await primaryRes.json()) as { live_primary_host_id: string | null }[];
    check(primaryRows[0]?.live_primary_host_id === cohostUserId, "the server holds the pin (events.live_primary_host_id)");
    check(
      !!(await until(
        "the host to be told the pin landed",
        async () =>
          /is on the main stage for everyone/i.test(
            (await host.page.getByTestId("room-toasts").innerText().catch(() => "")) || "",
          ),
        15_000,
      )),
      "the host who pinned is told it landed (a toast)",
    );

    // And back: the host pins themselves for everyone.
    const selfTile = host.page.locator(`[data-peer="${hostUserId}"][data-kind="camera"]`);
    if ((await selfTile.count()) > 0) {
      await selfTile.first().hover();
      await selfTile.first().getByTestId("tile-pin-everyone").click();
    }
    check(
      !!(await until(
        "the viewer's main stage to move back to the host",
        async () => (await mainTile(viewer.page))?.peer === hostUserId,
        20_000,
      )),
      "pinning the host again moves it back",
    );
    // The co-host leaves (staff get a menu: Leave, or End for everyone).
    check(
      (await tap(cohost.page, "ctrl-leave", "co-host's Leave")) &&
        (await tap(cohost.page, "leave-leave", "co-host's Leave menu item")),
      "the co-host left (the webinar keeps running)",
    );
    const cohostLeft = !!(await until("co-host left screen", async () => (await count(cohost.page, "end-left")) > 0, 15_000));
    check(cohostLeft, "the co-host sees \"You've left\"");
    // The co-host stays on "You've left" until after End for everyone (below):
    // their Rejoin then must land on the ended screen, not on Start webinar.
    if (!cohostLeft) await cohost.ctx.close().catch(() => {});

    // --- camera off must read as "camera off", not as a black frame -------
    //
    // A disabled track still transmits (black frames), so a viewer would see
    // a frozen picture rather than being told. The engine detaches the track
    // instead, which mutes the receiver's and lets the UI say so.
    console.log("\nhost turns the camera off");
    await tap(host.page, "ctrl-camera", "host's camera button");
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

    await tap(host.page, "ctrl-camera", "host's camera button");
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
      await tap(viewer.page, "ctrl-leave", "viewer's Leave button"),
      "viewer pressed Leave",
    );
    const leftScreen = await until(
      "viewer's left screen",
      async () => (await count(viewer.page, "end-left")) > 0 && (await hasText(viewer.page, /you.ve left/i)),
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
    const countsOne = await until(
      "host count to drop to 1",
      async () => (await audience(host.page)) === 1,
      30_000,
    );
    check(!!countsOne, "host's headcount drops when a viewer leaves");

    const beforeRejoin = await pcCount(viewer.page);
    check(
      await tap(viewer.page, "end-rejoin", "viewer's Rejoin button"),
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
    // One control (the Leave menu), two steps, and it must reach every viewer:
    // not by a poll but by the stage hint, and in every case well inside
    // ~15s. After it, the room is shut: no media, no rejoin, no fresh join.
    console.log("\nhost ends the webinar for everyone");
    const viewerPcsAtEnd = await pcCount(viewer.page);
    check(
      (await tap(host.page, "ctrl-leave", "host's Leave menu")) &&
        (await tap(host.page, "leave-end", "host's End for everyone")),
      "host armed End for everyone",
    );
    check(
      await tap(host.page, "leave-end-confirm", "End confirm step", 5_000),
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

    // A host who left before the End and presses Rejoin after it lands on the
    // ended screen (Reopen for staff) — the page's fresh render is the truth —
    // never back in a green room offering "Start webinar".
    if (cohostLeft) {
      check(await tap(cohost.page, "end-rejoin", "co-host's Rejoin after the End"), "the co-host pressed Rejoin after the End");
      const cohostOnEnded = await until(
        "the co-host's Rejoin to land on the ended screen",
        async () => (await count(cohost.page, "end-ended")) > 0 && (await count(cohost.page, "end-reopen")) > 0,
        30_000,
      );
      check(!!cohostOnEnded, "a host who left, rejoining after End for everyone, lands on the ended screen with Reopen");
      check((await count(cohost.page, "green-room-join")) === 0, "and is not offered Start webinar");
      await cohost.ctx.close().catch(() => {});
    }

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
      (await count(viewer.page, "end-rejoin")) === 0,
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
      (await count(late.page, "green-room-join")) === 0,
      "and there is no Join button to press",
    );
    await late.ctx.close().catch(() => {});

    // --- Reopen ------------------------------------------------------------
    //
    // Staff only, on the ended screen. Reopen alone puts nobody on air: the
    // host goes back through the green room and presses Start webinar.
    console.log("\nhost reopens");
    check(
      await tap(host.page, "end-reopen", "host's Reopen button"),
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
    // The in-room "Hosting" chip exactly — the green room's copy must not
    // pass for being on air.
    const hostingAgain = await until("host to be hosting again", async () =>
      hasText(host.page, /^\s*hosting\s*$/i),
    );
    check(!!hostingAgain, "host is broadcasting again");

    // The ended viewer is not reconnected behind their back; their ended
    // screen polls (15 s) and offers Rejoin once the webinar is open.
    const beforeReopenRejoin = await pcCount(viewer.page);
    check(
      await tap(viewer.page, "end-rejoin", "ended viewer to be offered Rejoin", 45_000),
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
    // --- A scheduled webinar opened hours early ------------------------------
    //
    // Before the go-live window (start − 60 min) a host is rehearsing:
    // nothing is stamped and students wait. Staff need not: Go live now moves
    // the run to now, lets the waiting student in and rings their bell. The
    // host's tab records it (auto-record); its email is off, so after End the
    // admin event page's "Share with students" is what lets students watch,
    // and their events lists then link to it.
    console.log("\na scheduled webinar, opened three hours early");
    // The first webinar is done; free its browsers.
    for (const c of contexts.splice(0)) await c.close().catch(() => {});
    const earlyId = await createScheduledWebinar(viewerUserId);
    const earlyRoom = `/dashboard/events/${earlyId}/live`;
    const early = await openAs(browser, HOST_EMAIL, earlyRoom, "early host");
    contexts.push(early.ctx);
    check(await enterRoom(early.page, "early host"), "the host opened the room three hours early");
    const rehearsing = await until(
      "the rehearsal notice with Go live now",
      async () => (await count(early.page, "go-live-now")) > 0,
      30_000,
    );
    check(!!rehearsing, "the host is rehearsing (\"Not live yet\"), with Go live now");
    check(!(await eventRow(earlyId))?.live_started_at, "nothing is stamped while the host rehearses");

    const waiting = await openAs(browser, VIEWER_EMAIL, earlyRoom, "waiting student");
    contexts.push(waiting.ctx);
    check(
      !!(await until("the student's wait page", async () => hasText(waiting.page, /opens 15 minutes before/i), 60_000)),
      "the enrolled student waits: it opens 15 minutes before the start",
    );

    const pressedAt = Date.now();
    check(await tap(early.page, "go-live-now", "Go live now"), "staff pressed Go live now");
    const started = await until(
      "live_started_at to be stamped",
      async () => {
        const row = await eventRow(earlyId);
        return row?.live_started_at ? row : null;
      },
      15_000,
    );
    check(!!started, "Go live now stamps live_started_at");
    if (started) {
      const startsAt = Date.parse(started.starts_at!);
      check(
        Math.abs(startsAt - pressedAt) < 2 * 60_000,
        "the event now starts this minute (it was three hours out)",
      );
      check(
        Date.parse(started.ends_at!) - startsAt === 45 * 60_000,
        "and keeps its 45 minutes",
      );
    }
    check(
      !!(await until("the rehearsal notice to go", async () => (await count(early.page, "go-live-now")) === 0, 20_000)),
      "the host's room is live: the rehearsal notice is gone",
    );
    check(
      !!(await until("REC in the host's top bar", async () => (await count(early.page, "badge-rec")) > 0, 45_000)),
      "the host's tab starts recording it (auto-record)",
    );
    const bell = await until(
      "the student's live bell",
      async () => {
        const res = await fetch(
          `${url}/rest/v1/notifications?user_id=eq.${viewerUserId}&type=eq.event_live&select=link`,
          { headers: adm },
        );
        const rows = res.ok ? ((await res.json()) as { link: string | null }[]) : [];
        return rows.find((r) => r.link === earlyRoom) ?? null;
      },
      20_000,
    );
    check(!!bell, "the enrolled student's bell says it's live, linking to the room");

    // The wait page re-asks the server every 30 s.
    const letIn = await until(
      "the waiting student to be let in",
      async () => (await count(waiting.page, "green-room-join")) > 0,
      60_000,
    );
    check(!!letIn, "the waiting student is let in without reloading");
    check(await enterRoom(waiting.page, "early student"), "and joins");
    check(
      await decodesAgain(waiting.page, 0, "the early student to decode the host"),
      "the student decodes the host's video",
    );

    // Record a few seconds, then End for everyone.
    await new Promise((r) => setTimeout(r, 6_000));
    check(
      (await tap(early.page, "ctrl-leave", "host's Leave menu")) &&
        (await tap(early.page, "leave-end", "host's End for everyone")) &&
        (await tap(early.page, "leave-end-confirm", "End confirm step", 5_000)),
      "the host ended it for everyone",
    );
    check(
      !!(await until("live_ended_at", async () => (await eventRow(earlyId))?.live_ended_at ?? null, 15_000)),
      "live_ended_at is stamped",
    );
    const earlyTakes = await until(
      "the webinar's take to be finished",
      async () => {
        const rows = await finishedTakes("webinar", earlyId);
        return rows.length > 0 ? rows : null;
      },
      90_000,
    );
    check(earlyTakes?.length === 1, "the host's tab saved it as one finished take");

    // Its email is off: nothing is shared until an admin shares it.
    const studentEvents = waiting.page;
    await studentEvents.goto(`${BASE}/dashboard/events`, { waitUntil: "domcontentloaded", timeout: 180_000 });
    check(
      !!(await until("the student's events list", async () => hasText(studentEvents, new RegExp(`E2E Early ${stamp}`)), 30_000)) &&
        (await count(studentEvents, "event-recording")) === 0,
      "before it is shared, the student's events list has no recording link",
    );
    const adminPage = await early.ctx.newPage();
    await adminPage.goto(`${BASE}/admin/events/${earlyId}`, { waitUntil: "domcontentloaded", timeout: 180_000 });
    check(await tap(adminPage, "share-files", "the admin page's Share with students", 60_000), "the admin pressed Share with students");
    check(
      !!(await until("the shared line", async () => (await count(adminPage, "files-shared")) > 0, 20_000)),
      "the admin event page says it is shared",
    );
    check(!!(await eventRow(earlyId))?.assets_shared_at, "assets_shared_at is stamped");

    await studentEvents.reload({ waitUntil: "domcontentloaded" });
    const link = await until(
      "the student's Watch recording link",
      async () => {
        const a = studentEvents.getByTestId("event-recording");
        return (await a.count()) > 0 ? a.first().getAttribute("href") : null;
      },
      30_000,
    );
    check(link === earlyRoom, "the student's events list links \"Watch recording\" to the room page");
    await studentEvents.goto(`${BASE}/app/events`, { waitUntil: "domcontentloaded", timeout: 180_000 });
    check(
      !!(await until(
        "the app's Recent recordings",
        async () => (await studentEvents.locator(`a[href="${earlyRoom}"]`).count()) > 0,
        30_000,
      )),
      "the app's events list has it under Recent recordings",
    );
    await studentEvents.goto(`${BASE}${earlyRoom}`, { waitUntil: "domcontentloaded", timeout: 180_000 });
    check(
      !!(await until("the recording on the event's page", async () => (await studentEvents.locator("video").count()) > 0, 30_000)),
      "the event's page plays the recording to the student",
    );

    console.log("\n1:1 call (mentor host)");
    // The webinar is done; free its browsers before the call's two.
    for (const c of contexts.splice(0)) await c.close().catch(() => {});
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

    // Two people: the other person is the main stage, yourself a small PiP.
    const twoUp = await until(
      "the student's stage to show the mentor, self in the corner",
      async () =>
        (await mainTile(callee.page))?.peer === mentorUserId && (await count(callee.page, "stage-pip")) > 0,
      20_000,
    );
    check(!!twoUp, "a 1:1 shows the other person on the main stage and yourself as a PiP");

    // The mentor's browser records (the call's team starts it on joining),
    // and the room says so — to everyone, the student included.
    const recording = await until("the mentor's Recording indicator", async () =>
      (await count(caller.page, "badge-rec")) > 0 && (await hasText(caller.page, /^\s*recording\s*$/i)),
    );
    check(!!recording, "the mentor's room shows it is recording");
    check(
      !!(await until("the student's REC badge", async () => (await count(callee.page, "badge-rec")) > 0, 30_000)),
      "the student sees the REC badge too",
    );

    // End call: in the Leave menu, offered once both people have been in the
    // room and the start has come (the call started two minutes ago), then
    // confirmed. Final for both.
    console.log("\nthe host ends the call");
    check(
      (await tap(caller.page, "ctrl-leave", "the mentor's Leave menu", 30_000)) &&
        (await tap(caller.page, "leave-end", "the mentor's End call")) &&
        (await tap(caller.page, "leave-end-confirm", "End call confirm", 5_000)),
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
    const takes = await until(
      "the call's recording to be saved as one take",
      async () => {
        const rows = await finishedTakes("call", inviteId);
        return rows.length > 0 ? rows : null;
      },
      60_000,
    );
    check(
      takes?.length === 1,
      "the mentor's browser recorded the call as ONE take and finished it after End call",
    );
    if (takes) info(`take: ${takes[0].part_count} part(s), ${Math.round(takes[0].duration_ms / 1000)}s`);
    if (takes?.length) {
      // Played back through the media route: ranged, as a <video> asks.
      const res = await caller.page.request.get(`${BASE}/api/recordings/${takes[0].id}/media`, {
        headers: { Range: "bytes=0-1023" },
      });
      check(
        res.status() === 206 && /^video\/webm/.test(res.headers()["content-type"] ?? ""),
        "the take's media route answers 206 with video/webm",
      );
      if (res.status() !== 206) info(`media route said ${res.status()}`);
    }

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
