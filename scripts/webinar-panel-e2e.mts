/**
 * Webinar side panel, end to end: chat, Q&A, polls, reactions across real
 * browsers on real Supabase.
 *
 *   npm run dev                 # in another terminal
 *   npm run webinar-panel-e2e
 *   npm run webinar-panel-e2e -- --headed
 *
 * One admin host and two students in an `open` webinar:
 *   - a send reaches everyone; a burst of sends arrives in order and the
 *     composer never locks;
 *   - an author deletes their own message, a host removes a student's: gone
 *     for everyone at once, and still gone after a resync and a reload (and
 *     soft-removed + audited in the database);
 *   - a question is asked, upvoted (the count survives a read), spotlighted
 *     and answered; a poll is launched, voted on, closed — and stays on the
 *     students' screens with its result; a draft never reaches them;
 *   - unread badges, the autoscroll "N new" pill, a reaction;
 *   - the room switched to `moderated`: a student's message is Pending for
 *     them, invisible to the other student, and appears for everyone on
 *     Approve.
 * Prints how long each removal took to land on every screen.
 *
 * Accounts are `e2e-panel-*@example.invalid` (a reserved TLD) with a random
 * password; everything this creates is removed in a finally block, and a run
 * reaps accounts an interrupted run left behind.
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
const COOKIE_NAME = `sb-${new URL(url).hostname.split(".")[0]}-auth-token`;
const MAX_CHUNK = 3180;
const adm = {
  apikey: serviceKey,
  Authorization: `Bearer ${serviceKey}`,
  "Content-Type": "application/json",
};
const PASSWORD = `e2e-${randomBytes(18).toString("base64url")}`;
const stamp = String(process.pid);

/** How long another screen may take to reflect a change (E2E_SPREAD_MS on a slow box). */
const SPREAD_MS = Number(process.env.E2E_SPREAD_MS) || 8_000;

let failures = 0;
const info = (m: string) => console.log(`        ${m}`);
function check(cond: boolean, m: string) {
  if (cond) console.log(`  ok    ${m}`);
  else {
    failures++;
    console.log(`  FAIL  ${m}`);
  }
}

const createdUsers: string[] = [];

/** Accounts an interrupted run left behind — only this script's exact shape. */
async function reapOrphans(): Promise<void> {
  const rows: { id: string; email: string }[] = await rest(
    "profiles?select=id,email&email=like.e2e-panel-*@example.invalid",
  ).catch(() => []);
  for (const r of rows) {
    if (!/^e2e-panel-[a-z]+-\d+@example\.invalid$/.test(r.email ?? "")) continue;
    await fetch(`${url}/auth/v1/admin/users/${r.id}`, { method: "DELETE", headers: adm }).catch(
      () => {},
    );
  }
}
let eventId: string | null = null;

async function rest(path: string, init?: RequestInit) {
  const res = await fetch(`${url}/rest/v1/${path}`, {
    ...init,
    headers: { ...adm, Prefer: "return=representation" },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path}: ${text}`);
  return text ? JSON.parse(text) : null;
}

async function createUser(email: string, role: string, name: string) {
  const res = await fetch(`${url}/auth/v1/admin/users`, {
    method: "POST",
    headers: adm,
    body: JSON.stringify({ email, password: PASSWORD, email_confirm: true }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`createUser ${email}: ${JSON.stringify(body)}`);
  createdUsers.push(body.id);
  await rest(`profiles?id=eq.${body.id}`, {
    method: "PATCH",
    body: JSON.stringify({ role, full_name: name }),
  });
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

async function cleanup() {
  if (eventId) {
    for (const table of ["webinar_messages", "webinar_questions", "webinar_polls", "live_participants"]) {
      await fetch(`${url}/rest/v1/${table}?event_id=eq.${eventId}`, {
        method: "DELETE",
        headers: adm,
      }).catch(() => {});
    }
    await fetch(`${url}/rest/v1/audit_log?payload->>eventId=eq.${eventId}`, {
      method: "DELETE",
      headers: adm,
    }).catch(() => {});
    await fetch(`${url}/rest/v1/events?id=eq.${eventId}`, {
      method: "DELETE",
      headers: adm,
    }).catch(() => {});
  }
  for (const id of createdUsers) {
    await fetch(`${url}/auth/v1/admin/users/${id}`, { method: "DELETE", headers: adm }).catch(
      () => {},
    );
  }
}

// --- browser helpers --------------------------------------------------------

async function until<T>(
  label: string,
  fn: () => Promise<T | null | undefined | false>,
  timeoutMs = SPREAD_MS,
): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) return v as T;
    } catch {
      /* mid-render; try again */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  info(`timed out waiting for ${label} (${timeoutMs / 1000}s)`);
  return null;
}

/** Wait for `fn`, returning how long it took (ms), or null. */
async function timed(label: string, fn: () => Promise<boolean>, timeoutMs = SPREAD_MS) {
  const t0 = Date.now();
  return (await until(label, fn, timeoutMs)) ? Date.now() - t0 : null;
}

async function openAs(browser: Browser, email: string, path: string, label: string) {
  const ctx = await browser.newContext({
    permissions: ["camera", "microphone"],
    baseURL: BASE,
    viewport: { width: 1400, height: 950 },
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
  const page = await ctx.newPage();
  page.on("pageerror", (e) => info(`[${label}] page error: ${e.message}`));
  await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded", timeout: 180_000 });
  return { ctx, page };
}

/** Through the green room and into the room, until the panel is on screen. */
async function enterRoom(page: Page, label: string): Promise<boolean> {
  const button = page.getByRole("button", {
    name: /^(start|start webinar|join|join as co-host)$/i,
  });
  const ready = await until(
    `${label} green room`,
    async () => (await button.count()) > 0 && (await button.first().isEnabled()),
    120_000,
  );
  if (!ready) return false;
  // The panel needs no video; a host without a camera keeps the run light.
  const cameraOff = page.getByRole("button", { name: /turn camera off/i });
  if ((await cameraOff.count()) > 0) await cameraOff.first().click().catch(() => {});
  await button.first().click();
  const tabs = page.getByRole("tablist", { name: "Webinar panel" });
  const shown = await until(
    `${label} panel`,
    async () => {
      if ((await tabs.count()) > 0 && (await tabs.first().isVisible())) return true;
      // A room that keeps the panel closed: open it.
      const toggle = page.getByRole("button", { name: /^chat$/i });
      if ((await toggle.count()) > 0) await toggle.first().click();
      return false;
    },
    60_000,
  );
  // Realtime subscriptions settle a beat after the join.
  await new Promise((r) => setTimeout(r, 1500));
  return !!shown;
}

const message = (page: Page, text: string) =>
  page.locator("li[data-message-id]", { hasText: text });
const hasMessage = async (page: Page, text: string) =>
  (await message(page, text).count()) > 0;
const question = (page: Page, text: string) =>
  page.locator("li[data-question-id]", { hasText: text });
const poll = (page: Page, text: string) =>
  page.locator("li[data-poll-id]", { hasText: text });

async function say(page: Page, text: string) {
  const box = page.getByRole("textbox", { name: "Chat message" });
  await box.fill(text);
  await box.press("Enter");
}

async function rowAction(row: ReturnType<typeof message>, name: string) {
  await row.hover();
  await row.getByRole("button", { name, exact: true }).click();
}

const tab = (page: Page, name: RegExp) => page.getByRole("tab", { name }).click();

// --- the test ---------------------------------------------------------------

async function main() {
  console.log("\nwebinar-panel-e2e\n");
  const health = await fetch(BASE).catch(() => null);
  if (!health?.ok) {
    console.error(`No dev server at ${BASE}. Run \`npm run dev\` first.`);
    process.exit(1);
  }

  await reapOrphans();
  console.log("fixtures");
  const HOST = `e2e-panel-host-${stamp}@example.invalid`;
  const ADA = `e2e-panel-ada-${stamp}@example.invalid`;
  const BEN = `e2e-panel-ben-${stamp}@example.invalid`;
  await createUser(HOST, "admin", "Hana Host");
  await createUser(ADA, "student", "Ada Student");
  await createUser(BEN, "student", "Ben Student");
  const now = Date.now();
  const [event] = await rest("events", {
    method: "POST",
    body: JSON.stringify({
      title: `E2E Panel ${stamp}`,
      type: "webinar",
      starts_at: new Date(now - 5 * 60_000).toISOString(),
      ends_at: new Date(now + 55 * 60_000).toISOString(),
      visibility: "public",
      live_mode: "hosted",
      audience_mode: "open",
    }),
  });
  eventId = event.id as string;
  info(`event ${eventId}`);

  let browser: Browser | null = null;
  const contexts: BrowserContext[] = [];
  try {
    browser = await chromium.launch({
      headless: !headed,
      args: [
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
        "--autoplay-policy=no-user-gesture-required",
        "--mute-audio",
      ],
    });
    const live = `/dashboard/events/${eventId}/live`;
    const host = await openAs(browser, HOST, live, "host");
    contexts.push(host.ctx);
    check(await enterRoom(host.page, "host"), "host is in the room with the panel");
    const ada = await openAs(browser, ADA, live, "ada");
    contexts.push(ada.ctx);
    check(await enterRoom(ada.page, "ada"), "Ada is in the room with the panel");
    const ben = await openAs(browser, BEN, live, "ben");
    contexts.push(ben.ctx);
    check(await enterRoom(ben.page, "ben"), "Ben is in the room with the panel");

    // --- chat ----------------------------------------------------------------
    console.log("\nchat");
    await say(ada.page, "hello from Ada");
    check(!!(await timed("Ada's own", () => hasMessage(ada.page, "hello from Ada"))), "Ada sees her message");
    const toBen = await timed("Ben sees Ada", () => hasMessage(ben.page, "hello from Ada"));
    check(toBen !== null, `Ben sees it (${toBen}ms)`);
    check(
      (await message(ben.page, "hello from Ada").innerText()).includes("Ada Student"),
      "with Ada's name (open room)",
    );
    check(!!(await timed("host sees Ada", () => hasMessage(host.page, "hello from Ada"))), "the host sees it");

    const box = ada.page.getByRole("textbox", { name: "Chat message" });
    let unlocked = true;
    for (let i = 1; i <= 3; i++) {
      await box.fill(`burst ${i}`);
      unlocked &&= await box.isEnabled();
      await box.press("Enter");
    }
    check(unlocked, "the composer never locks while sending");
    const burst = await until("burst on Ben", async () => {
      for (const t of ["burst 1", "burst 2", "burst 3"]) if (!(await hasMessage(ben.page, t))) return false;
      return true;
    });
    const texts = burst ? await ben.page.locator("li[data-message-id]").allInnerTexts() : [];
    const at = (t: string) => texts.findIndex((x) => x.includes(t));
    check(!!burst && at("burst 1") < at("burst 2") && at("burst 2") < at("burst 3"), "a burst of sends arrives, in order");

    await say(host.page, "welcome, host here");
    check(!!(await until("Ada sees host", () => hasMessage(ada.page, "welcome, host here"))), "students see the host's message");
    check(
      (await message(ada.page, "welcome, host here").innerText()).includes("Host"),
      "…marked Host",
    );

    // --- delete own ------------------------------------------------------------
    console.log("\ndelete your own");
    await say(ben.page, "oops wrong room");
    await until("Ada sees Ben's", () => hasMessage(ada.page, "oops wrong room"));
    await until("host sees Ben's", () => hasMessage(host.page, "oops wrong room"));
    const others = message(ada.page, "oops wrong room");
    check(
      (await others.getByRole("button", { name: "Delete", exact: true }).count()) === 0 &&
        (await others.getByRole("button", { name: "Remove", exact: true }).count()) === 0,
      "a student cannot delete someone else's message",
    );
    await message(ben.page, "oops wrong room").hover();
    const [delSelf, delAda, delHost] = await Promise.all([
      timed("gone for Ben", async () => !(await hasMessage(ben.page, "oops wrong room")), 1500),
      timed("gone for Ada", async () => !(await hasMessage(ada.page, "oops wrong room"))),
      timed("gone for host", async () => !(await hasMessage(host.page, "oops wrong room"))),
      message(ben.page, "oops wrong room").getByRole("button", { name: "Delete", exact: true }).click(),
    ]);
    check(delSelf !== null, `gone for its author at once (${delSelf}ms)`);
    check(delAda !== null && delHost !== null, `gone for everyone (Ada ${delAda}ms, host ${delHost}ms)`);

    // --- host removes -----------------------------------------------------------
    console.log("\nhost removes");
    await message(host.page, "hello from Ada").hover();
    const [remHost, remAda, remBen] = await Promise.all([
      timed("gone for host", async () => !(await hasMessage(host.page, "hello from Ada")), 1500),
      timed("gone for Ada", async () => !(await hasMessage(ada.page, "hello from Ada"))),
      timed("gone for Ben", async () => !(await hasMessage(ben.page, "hello from Ada"))),
      message(host.page, "hello from Ada").getByRole("button", { name: "Remove", exact: true }).click(),
    ]);
    check(remHost !== null, `gone for the host at once (${remHost}ms)`);
    check(remAda !== null, `gone for its author (${remAda}ms)`);
    check(remBen !== null, `gone for Ben (${remBen}ms)`);

    info("waiting out a full resync (22s)…");
    await new Promise((r) => setTimeout(r, 22_000));
    for (const [page, who] of [
      [host.page, "host"],
      [ada.page, "Ada"],
      [ben.page, "Ben"],
    ] as const) {
      check(
        !(await hasMessage(page, "hello from Ada")) && !(await hasMessage(page, "oops wrong room")),
        `${who}: removed messages stay gone after a resync`,
      );
    }
    await host.page.reload({ waitUntil: "domcontentloaded" });
    check(await enterRoom(host.page, "host again"), "the host rejoins after a reload");
    check(
      !!(await until("history", () => hasMessage(host.page, "welcome, host here"))) &&
        !(await hasMessage(host.page, "hello from Ada")),
      "after a reload: history is back, the removed message is not",
    );
    const rows = await rest(`webinar_messages?event_id=eq.${eventId}&select=body,removed_at`);
    check(
      rows.filter((r: { removed_at: string | null }) => r.removed_at).length === 2,
      "both rows are soft-removed in the database",
    );
    const audit = (await rest(`audit_log?payload->>eventId=eq.${eventId}&select=action`)).map(
      (r: { action: string }) => r.action,
    );
    check(
      audit.includes("webinar.chat_removed") && audit.includes("webinar.chat_deleted"),
      "removal and self-delete are audited",
    );

    // --- Q&A ------------------------------------------------------------------
    console.log("\nq&a");
    await tab(ada.page, /^Q&A/);
    const ask = ada.page.getByRole("textbox", { name: "Your question" });
    await ask.fill("What is the best first customer?");
    await ask.press("Enter");
    const q = (p: Page) => question(p, "best first customer");
    check(!!(await until("Ada's question", async () => (await q(ada.page).count()) > 0)), "Ada sees her question");
    await tab(ben.page, /^Q&A/);
    check(!!(await until("Ben sees it", async () => (await q(ben.page).count()) > 0)), "Ben sees it (open room)");
    await q(ben.page).getByRole("button", { name: "Upvote" }).click();
    await tab(host.page, /^Q&A/);
    check(
      !!(await until("host sees 1 vote", async () => /\b1\b/.test(await q(host.page).innerText()))),
      "the host sees the upvote count",
    );
    await new Promise((r) => setTimeout(r, 1500));
    check(
      (await q(ben.page).getByRole("button", { name: "Remove upvote" }).count()) === 1 &&
        /\b1\b/.test(await q(ben.page).innerText()),
      "Ben's upvote survives a read (count and pressed state)",
    );
    await rowAction(q(host.page), "Spotlight");
    check(!!(await until("spotlight", async () => (await q(ben.page).innerText()).includes("Spotlight"))), "the spotlight reaches students");
    check(
      (await q(host.page).getByRole("button", { name: "Unspotlight" }).count()) === 1,
      "the host can take it down again",
    );
    await rowAction(q(host.page), "Answered");
    check(!!(await until("answered", async () => (await q(ada.page).innerText()).includes("Answered"))), "Answered reaches the asker");

    // --- polls ----------------------------------------------------------------
    console.log("\npolls");
    await tab(host.page, /^Polls/);
    await host.page.getByRole("button", { name: "New poll" }).click();
    await host.page.getByRole("textbox", { name: "Poll question" }).fill("Ship it?");
    await host.page.getByRole("textbox", { name: "Option 1" }).fill("Yes");
    await host.page.getByRole("textbox", { name: "Option 2" }).fill("No");
    await host.page.getByRole("button", { name: "Launch" }).click();
    check(
      !!(await until("Ada's Polls badge", async () =>
        /1/.test(await ada.page.getByRole("tab", { name: /^Polls/ }).innerText()),
      )),
      "Ada's Polls tab badges the new poll",
    );
    await tab(ada.page, /^Polls/);
    await tab(ben.page, /^Polls/);
    await until("poll on Ada", async () => (await poll(ada.page, "Ship it?").count()) > 0);
    await poll(ada.page, "Ship it?").getByRole("button", { name: /^Yes/ }).click();
    await until("poll on Ben", async () => (await poll(ben.page, "Ship it?").count()) > 0);
    await poll(ben.page, "Ship it?").getByRole("button", { name: /^No/ }).click();
    check(
      !!(await until("2 votes", async () => (await poll(host.page, "Ship it?").innerText()).includes("2 votes"))),
      "the host sees both votes",
    );
    await poll(host.page, "Ship it?").getByRole("button", { name: "Close" }).click();
    const closed = await until("closed on Ada", async () =>
      (await poll(ada.page, "Ship it?").innerText()).includes("Closed"),
    );
    check(!!closed, "a closed poll stays on the students' screens");
    check((await poll(ada.page, "Ship it?").innerText()).includes("50%"), "…with its result");
    check(await poll(ada.page, "Ship it?").getByRole("button", { name: /^Yes/ }).isDisabled(), "…and takes no more votes");

    await host.page.getByRole("button", { name: "New poll" }).click();
    await host.page.getByRole("textbox", { name: "Poll question" }).fill("Secret draft?");
    await host.page.getByRole("textbox", { name: "Option 1" }).fill("A");
    await host.page.getByRole("textbox", { name: "Option 2" }).fill("B");
    await host.page.getByRole("button", { name: "Save draft" }).click();
    await until("draft on host", async () => (await poll(host.page, "Secret draft?").count()) > 0);
    await new Promise((r) => setTimeout(r, 2000));
    check((await poll(ben.page, "Secret draft?").count()) === 0, "a draft never reaches students");

    // --- unread, autoscroll, reactions ------------------------------------------
    console.log("\nunread · autoscroll · reactions");
    await tab(ada.page, /^Chat/);
    await say(ada.page, "ping for the badge");
    check(
      !!(await until("host Chat badge", async () =>
        /1/.test(await host.page.getByRole("tab", { name: /^Chat/ }).innerText()),
      )),
      "a new message badges the host's Chat tab",
    );
    await tab(host.page, /^Chat/);
    check(
      !!(await until("badge cleared", async () =>
        !/\d/.test(await host.page.getByRole("tab", { name: /^Chat/ }).innerText()),
      )),
      "opening Chat clears it",
    );

    await tab(ben.page, /^Chat/);
    // Four long lines (the chat rate limit is 5 per 10s) to overflow the log.
    for (let i = 0; i < 4; i++) await say(host.page, `filler ${i} ${"lorem ipsum ".repeat(30)}`);
    await until("filler on Ben", () => hasMessage(ben.page, "filler 3"));
    const log = ben.page.getByRole("log", { name: "Chat messages" });
    const nearBottom = () => log.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 60);
    check(await nearBottom(), "a reader at the bottom follows new messages");
    await log.evaluate((el) => (el.scrollTop = 0));
    await new Promise((r) => setTimeout(r, 300));
    await say(host.page, "while you scrolled up");
    const pill = ben.page.getByRole("button", { name: /^1 new/ });
    check(!!(await until("pill", async () => (await pill.count()) > 0)), "a reader scrolled up gets a '1 new' pill");
    if ((await pill.count()) > 0) await pill.click();
    check(await nearBottom(), "the pill jumps to the newest");

    await ada.page.getByRole("button", { name: "Reactions" }).click();
    await ada.page.getByRole("button", { name: "React 👏" }).click();
    check(!!(await until("clap on Ben", async () => (await ben.page.getByText("👏").count()) > 0, 4000)), "a reaction floats on another screen");

    // --- moderated -------------------------------------------------------------
    console.log("\nmoderated");
    await rest(`events?id=eq.${eventId}`, {
      method: "PATCH",
      body: JSON.stringify({ audience_mode: "moderated" }),
    });
    info("waiting for the panels' next read (22s)…");
    await new Promise((r) => setTimeout(r, 22_000));
    await say(ada.page, "needs a look");
    check(
      !!(await until("pending for Ada", async () =>
        (await hasMessage(ada.page, "needs a look")) &&
        (await message(ada.page, "needs a look").innerText()).includes("Pending"),
      )),
      "a student's message is Pending for them",
    );
    check(!!(await until("host queue", () => hasMessage(host.page, "needs a look"))), "the host sees it in the queue");
    await new Promise((r) => setTimeout(r, 1000));
    check(!(await hasMessage(ben.page, "needs a look")), "other students do not");
    await rowAction(message(host.page, "needs a look"), "Approve");
    check(!!(await until("approved for Ben", () => hasMessage(ben.page, "needs a look"))), "after Approve, everyone does");
    check(
      !!(await until("not pending", async () =>
        !(await message(ada.page, "needs a look").innerText()).includes("Pending"),
      )),
      "and it is no longer Pending for its author",
    );

    if (headed) await new Promise((r) => setTimeout(r, 15_000));
  } finally {
    for (const c of contexts) await c.close().catch(() => {});
    await browser?.close().catch(() => {});
    await cleanup();
    info("test accounts and event removed");
  }

  console.log(failures === 0 ? "\nAll panel checks passed.\n" : `\n${failures} check(s) FAILED.\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  await cleanup();
  console.error("\nwebinar-panel-e2e failed:\n", err instanceof Error ? err.stack : err);
  process.exit(1);
});
