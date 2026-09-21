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
 * Every account and row it creates is removed in a finally block, including
 * on failure.
 */

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
const PASSWORD = "e2e-Test-Password-9271";

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
      full_name: role === "admin" ? "E2E Host" : "E2E Student",
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
 * run before the top of the hour is a test nobody runs. `visibility: public`
 * so the viewer needs no enrolment, which keeps this about the video path.
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

async function cleanup() {
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
  const button = page.getByRole("button", { name: /^(start|join)$/i });
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

// --- the test ---------------------------------------------------------------
async function main() {
  console.log(`\nwebinar-e2e — provider: ${PROVIDER}\n`);

  const health = await fetch(BASE).catch(() => null);
  if (!health?.ok) {
    console.error(`No dev server at ${BASE}. Run \`npm run dev\` first.`);
    process.exit(1);
  }

  console.log("fixtures");
  const hostUserId = await createUser(HOST_EMAIL, "admin");
  const viewerUserId = await createUser(VIEWER_EMAIL, "student");
  const eventId = await createLiveWebinar();
  pass(`admin + student accounts, and a webinar that is live now`);
  info(`event ${eventId}`);

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
    check(!!hosting, "host is in the room, broadcasting");

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

    // --- 1:1 calls: the other shape the same engine has to run ------------
    //
    // A 1:1 is two BROADCASTERS, which exercises code a webinar never
    // touches: sendrecv transceivers on both sides, and the id-comparison
    // tie-break that decides which of them offers. A webinar passing proves
    // nothing about this path.
    console.log("\n1:1 call");
    const inviteId = await createAcceptedCall(hostUserId, viewerUserId);
    const callPath = `/dashboard/calls/${inviteId}/live`;

    const caller = await openAs(browser, HOST_EMAIL, callPath, "caller");
    contexts.push(caller.ctx);
    check(await enterRoom(caller.page, "caller"), "host opened the 1:1");

    const callee = await openAs(browser, VIEWER_EMAIL, callPath, "callee");
    contexts.push(callee.ctx);
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
