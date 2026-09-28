/**
 * Direct messages, end to end, in real browsers against the real app.
 *
 *   npm run dev        # in another terminal
 *   npm run dm-e2e
 *   npm run dm-e2e -- --headed
 *   npm run dm-e2e -- --shots=/tmp/dm-shots   # save phone/desktop screenshots
 *
 * Four throwaway accounts — a student, a mentor, an admin (moderator) and an
 * outsider — walk the whole feature:
 *
 *   - a brand-new, unvetted student can't cold-message the mentor (only the
 *     team), and is told why; once accepted, the DM from /messages?to= sends;
 *   - the mentor, sitting on their own home page, gets the unread badge on
 *     the chat dock without reloading, opens the dock, and reads it;
 *   - replies arrive live on the other side, in both directions;
 *   - an unsent message disappears from the other person's screen;
 *   - a block stops both sides sending, without telling the blocked person;
 *   - the outsider can neither open the conversation by id nor write to the
 *     DM tables directly through the API;
 *   - minimizing and reopening the dock brings back the current thread;
 *   - a report opens the conversation to the admin's moderation queue, and
 *     the person reported sees nothing different — they can still unsend,
 *     and what they unsend stays in the moderator's transcript, marked;
 *   - on a phone and on a desktop, neither /messages nor the open dock
 *     scrolls sideways, and the composer stays on screen.
 *
 * Every account, row and notification it creates is removed in a finally
 * block, including on failure; `reapOrphans` catches a run that was killed.
 */

import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const headed = process.argv.includes("--headed");
const shotsArg = process.argv.find((a) => a.startsWith("--shots="));
const SHOTS = shotsArg ? shotsArg.split("=")[1] : null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

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
const EMAIL = {
  student: `e2e-dm-student-${stamp}@example.invalid`,
  mentor: `e2e-dm-mentor-${stamp}@example.invalid`,
  admin: `e2e-dm-admin-${stamp}@example.invalid`,
  outsider: `e2e-dm-outsider-${stamp}@example.invalid`,
};
const NAME = {
  student: "E2E Dmstudent",
  mentor: "E2E Dmmentor",
  admin: "E2E Dmadmin",
  outsider: "E2E Dmoutsider",
};
/** Random every run and never written down: an orphaned account is inert. */
const PASSWORD = `e2e-${randomBytes(18).toString("base64url")}`;

/** Remove accounts a killed run left behind. Scoped to this script's own shape. */
async function reapOrphans(): Promise<void> {
  const res = await fetch(
    `${url}/rest/v1/profiles?select=id,email&email=like.e2e-dm-*@example.invalid`,
    { headers: adm },
  );
  if (!res.ok) return;
  const rows = (await res.json()) as { id: string; email: string }[];
  for (const r of rows) {
    if (!/^e2e-dm-[a-z]+-[0-9]+@example\.invalid$/.test(r.email ?? "")) continue;
    await fetch(`${url}/auth/v1/admin/users/${r.id}`, { method: "DELETE", headers: adm }).catch(() => {});
    console.log(`  reaped orphaned test account ${r.email}`);
  }
}

const createdUsers: string[] = [];
const conversations = new Set<string>();

async function createUser(email: string, role: string, fullName: string): Promise<string> {
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
    headers: { ...adm, Prefer: "return=representation" },
    body: JSON.stringify({ role, full_name: fullName }),
  });
  if (!patch.ok) throw new Error(`setRole ${email}: ${await patch.text()}`);
  return body.id;
}

async function signIn(email: string): Promise<any> {
  const res = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: anonKey, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const session = await res.json();
  if (!res.ok) throw new Error(`signIn ${email}: ${JSON.stringify(session)}`);
  return session;
}

/** The session, encoded the way @supabase/ssr reads it from cookies. */
function sessionCookies(session: any): { name: string; value: string }[] {
  const value = "base64-" + Buffer.from(JSON.stringify(session), "utf8").toString("base64url");
  if (value.length <= MAX_CHUNK) return [{ name: COOKIE_NAME, value }];
  const parts: { name: string; value: string }[] = [];
  for (let i = 0, n = 0; i < value.length; i += MAX_CHUNK, n++) {
    parts.push({ name: `${COOKIE_NAME}.${n}`, value: value.slice(i, i + MAX_CHUNK) });
  }
  return parts;
}

async function conversationBetween(a: string, b: string): Promise<any | null> {
  const [x, y] = a < b ? [a, b] : [b, a];
  const res = await fetch(
    `${url}/rest/v1/dm_conversations?select=*&user_a=eq.${x}&user_b=eq.${y}`,
    { headers: adm },
  );
  if (!res.ok) return null;
  const rows = await res.json();
  if (rows[0]) conversations.add(rows[0].id);
  return rows[0] ?? null;
}

async function cleanup() {
  for (const id of conversations) {
    // A report bells every moderator — real staff included. Take those bells
    // back, and the audit entries that name only this throwaway conversation.
    await fetch(`${url}/rest/v1/notifications?link=eq.${encodeURIComponent(`/admin/messages/${id}`)}`, {
      method: "DELETE",
      headers: adm,
    }).catch(() => {});
    await fetch(`${url}/rest/v1/audit_log?target_id=eq.${id}`, { method: "DELETE", headers: adm }).catch(() => {});
  }
  // Conversations, messages, blocks, reports and the users' own notifications
  // all cascade from the profiles.
  for (const id of createdUsers) {
    await fetch(`${url}/auth/v1/admin/users/${id}`, { method: "DELETE", headers: adm }).catch(() => {});
  }
}

// --- browser helpers --------------------------------------------------------
async function until<T>(
  label: string,
  fn: () => Promise<T | null | undefined | false>,
  timeoutMs = 30_000,
): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) return v as T;
    } catch {
      /* mid-navigation; try again */
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  info(`timed out waiting for ${label} (${timeoutMs / 1000}s)`);
  return null;
}

async function openAs(
  browser: Browser,
  session: any,
  path: string,
  label: string,
  viewport = { width: 1280, height: 800 },
): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ baseURL: BASE, viewport });
  await ctx.addCookies(
    sessionCookies(session).map((c) => ({
      name: c.name,
      value: c.value,
      url: BASE,
      httpOnly: false,
      secure: false,
      sameSite: "Lax" as const,
    })),
  );
  const page = await ctx.newPage();
  page.on("pageerror", (e) => info(`[${label}] page error: ${e.message.slice(0, 300)}`));
  page.on("console", (m) => {
    if (m.type() === "error") info(`[${label}] console: ${m.text().slice(0, 300)}`);
  });
  await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded" });
  return { ctx, page };
}

const visibleText = async (page: Page, text: string) =>
  (await page.getByText(text, { exact: true }).count()) > 0 &&
  (await page.getByText(text, { exact: true }).first().isVisible());

async function send(page: Page, text: string): Promise<boolean> {
  const box = page.getByRole("textbox", { name: /^Message / });
  const ok = await until("the composer", async () => (await box.count()) > 0 && (await box.first().isEnabled()));
  if (!ok) return false;
  await box.first().fill(text);
  await box.first().press("Enter");
  return true;
}

/** Nothing on the page scrolls sideways. */
const NO_SIDEWAYS = `(() => document.documentElement.scrollWidth <= window.innerWidth + 1)()`;

/** Is `locator`'s box fully inside the viewport? */
async function onScreen(page: Page, selector: string): Promise<boolean> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.top >= 0 && r.left >= 0 && r.bottom <= window.innerHeight + 1 && r.right <= window.innerWidth + 1;
  }, selector);
}

async function shot(page: Page, name: string) {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: false });
}

// --- the run ------------------------------------------------------------------
async function main() {
  console.log(`\ndm-e2e against ${BASE}\n`);
  console.log(`  !!  writing test rows to Supabase project ${projectRef}\n`);
  await reapOrphans();

  let browser: Browser | null = null;
  try {
    console.log("fixtures");
    const studentId = await createUser(EMAIL.student, "student", NAME.student);
    const mentorId = await createUser(EMAIL.mentor, "mentor", NAME.mentor);
    await createUser(EMAIL.admin, "admin", NAME.admin);
    await createUser(EMAIL.outsider, "student", NAME.outsider);
    const sessions = {
      student: await signIn(EMAIL.student),
      mentor: await signIn(EMAIL.mentor),
      admin: await signIn(EMAIL.admin),
      outsider: await signIn(EMAIL.outsider),
    };
    pass("student, mentor, admin and outsider accounts");

    browser = await chromium.launch({ headless: !headed });

    // --- who may cold-message whom -------------------------------------------
    console.log("\nwho may cold-message whom");
    const fresh = await openAs(browser, sessions.student, `/messages?to=${mentorId}`, "student-unvetted");
    await fresh.page.waitForLoadState("networkidle").catch(() => {});
    check(
      !(await fresh.page.getByRole("textbox", { name: /^Message / }).count()),
      "an unvetted new account gets no composer for a mentor it was never let near",
    );
    await fresh.ctx.close();
    // Accepted: now they're in.
    const accepted = await fetch(`${url}/rest/v1/applications`, {
      method: "POST",
      headers: adm,
      body: JSON.stringify({ user_id: studentId, status: "accepted" }),
    });
    check(accepted.ok, "the student is accepted");

    // --- start a conversation ------------------------------------------------
    console.log("\nstart a conversation");
    const student = await openAs(browser, sessions.student, `/messages?to=${mentorId}`, "student");
    check(
      !!(await until("the draft thread", async () => visibleText(student.page, NAME.mentor))),
      "/messages?to= opens a draft to the mentor",
    );
    const mentor = await openAs(browser, sessions.mentor, "/mentor", "mentor");
    const launcher = mentor.page.getByRole("button", { name: /^Messages/ });
    check(
      !!(await until("the mentor's chat launcher", async () => (await launcher.count()) > 0 && launcher.first().isVisible())),
      "the chat dock's launcher is on the mentor's home page",
    );
    // Let the mentor's live subscriptions settle before the message goes out.
    await mentor.page.waitForTimeout(2500);

    const first = `hello from the student ${stamp}`;
    check(await send(student.page, first), "the student sent a first message");
    check(
      !!(await until("the first message to confirm", async () =>
        (await visibleText(student.page, first)) && !(await visibleText(student.page, "Sending…")),
      )),
      "it shows as sent, not stuck on Sending…",
    );
    const convo = await until("the conversation row", () => conversationBetween(studentId, mentorId), 10_000);
    check(!!convo && convo.message_count === 1, "one conversation, one message, in the database");
    const convoId: string | null = convo?.id ?? null;

    // --- the other side hears about it --------------------------------------
    console.log("\nthe mentor hears about it");
    const t0 = Date.now();
    const badged = await until(
      "the unread badge",
      async () => (await mentor.page.getByRole("button", { name: /^Messages \(1 unread\)$/ }).count()) > 0,
      75_000,
    );
    check(!!badged, "the dock shows 1 unread without a reload");
    if (badged) info(`badge appeared ${Date.now() - t0}ms after the send`);

    await launcher.first().click();
    const dock = mentor.page.getByRole("dialog", { name: "Messages" });
    check(!!(await until("the dock panel", async () => dock.isVisible())), "the dock opens");
    const row = dock.getByRole("button", { name: new RegExp(NAME.student) });
    check(!!(await until("the student's row in the dock", async () => (await row.count()) > 0)), "the conversation is listed in the dock");
    await row.first().click();
    check(!!(await until("the message in the dock", async () => visibleText(mentor.page, first))), "the mentor reads it in the dock");

    // --- live, both ways ------------------------------------------------------
    console.log("\nlive, both ways");
    await mentor.page.waitForTimeout(1500);
    const reply = `reply from the mentor ${stamp}`;
    check(await send(mentor.page, reply), "the mentor replied from the dock");
    check(
      !!(await until("the reply on the student's screen", async () => visibleText(student.page, reply), 20_000)),
      "the reply appears on the student's open thread without a reload",
    );
    const second = `second from the student ${stamp}`;
    check(await send(student.page, second), "the student sent another");
    check(
      !!(await until("the second message in the dock", async () => visibleText(mentor.page, second), 20_000)),
      "it appears in the mentor's open dock thread live",
    );
    const dupes = await student.page.getByText(first, { exact: true }).count();
    check(dupes === 1, "no message is duplicated on the sender's screen");

    // Minimize and reopen: the dock must come back on the live thread, not a
    // stale copy from before it was closed.
    await mentor.page.getByRole("button", { name: "Minimize messages" }).first().click();
    const whileClosed = `while the dock was shut ${stamp}`;
    check(await send(student.page, whileClosed), "the student wrote while the mentor's dock was shut");
    await until("the mentor's launcher", async () => (await launcher.count()) > 0 && launcher.first().isVisible());
    await launcher.first().click();
    check(
      !!(await until("the message sent while shut", async () => visibleText(mentor.page, whileClosed), 20_000)),
      "reopening the dock shows what arrived while it was shut",
    );

    // --- unsend ----------------------------------------------------------------
    console.log("\nunsend");
    const bubble = student.page.getByText(second, { exact: true }).first();
    await bubble.hover().catch(() => {});
    const unsend = student.page.locator("li", { has: student.page.getByText(second, { exact: true }) }).getByRole("button", { name: "Unsend message" });
    if ((await unsend.count()) > 0) {
      await unsend.first().click();
      // Unsending asks first — it can't be undone.
      await student.page.getByRole("button", { name: /^Unsend$/ }).first().click();
      check(
        !!(await until("the unsent message to leave the student's screen", async () => !(await visibleText(student.page, second)), 10_000)),
        "unsend removes it from the sender's screen",
      );
      check(
        !!(await until("the unsent message to leave the mentor's screen", async () => !(await visibleText(mentor.page, second)), 35_000)),
        "…and from the other person's open thread (resync)",
      );
    } else {
      check(false, "the sender can unsend their own message");
    }

    // --- privacy --------------------------------------------------------------
    console.log("\nprivacy");
    const outsider = await openAs(browser, sessions.outsider, `/messages?c=${convoId}`, "outsider");
    await outsider.page.waitForLoadState("networkidle").catch(() => {});
    check(!(await visibleText(outsider.page, first)) && !(await visibleText(outsider.page, reply)), "an outsider opening the conversation by id sees none of it");
    for (const [table, body] of [
      ["dm_messages", { conversation_id: convoId, sender_id: sessions.outsider.user.id, body: "injected" }],
      ["dm_conversations", { user_a: studentId < sessions.outsider.user.id ? studentId : sessions.outsider.user.id, user_b: studentId < sessions.outsider.user.id ? sessions.outsider.user.id : studentId }],
    ] as const) {
      const res = await fetch(`${url}/rest/v1/${table}`, {
        method: "POST",
        headers: { apikey: anonKey, Authorization: `Bearer ${sessions.outsider.access_token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      check(!res.ok, `a signed-in user cannot write ${table} directly through the API (${res.status})`);
    }
    const peek = await fetch(`${url}/rest/v1/dm_messages?select=body&conversation_id=eq.${convoId}`, {
      headers: { apikey: anonKey, Authorization: `Bearer ${sessions.outsider.access_token}` },
    });
    const peeked = peek.ok ? await peek.json() : [];
    check(Array.isArray(peeked) && peeked.length === 0, "…nor read its messages");
    const rpc = await fetch(`${url}/rest/v1/rpc/dm_is_blocked`, {
      method: "POST",
      headers: { apikey: anonKey, Authorization: `Bearer ${sessions.student.access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ x: studentId, y: mentorId }),
    });
    check(!rpc.ok, `nobody can ask the API whether they have been blocked (${rpc.status})`);

    // --- block ----------------------------------------------------------------
    console.log("\nblock");
    await mentor.page.getByRole("button", { name: "Conversation options" }).first().click();
    await mentor.page.getByRole("menuitem", { name: /^Block / }).first().click();
    await mentor.page.getByRole("button", { name: /^Block$/ }).first().click();
    check(
      !!(await until("the mentor's blocked notice", async () => (await mentor.page.getByText(/You blocked/).count()) > 0)),
      "the mentor blocked the student",
    );
    const afterBlock = `after the block ${stamp}`;
    await send(student.page, afterBlock);
    const refused = await until("the student's send to be refused", async () =>
      (await student.page.getByRole("alert").count()) > 0 || (await student.page.getByText(/can.t send/i).count()) > 0,
    );
    check(!!refused, "the blocked student's send is refused");
    const leaked = (await student.page.getByText(/blocked you/i).count()) > 0;
    check(!leaked, "…without telling them they were blocked");
    const convoAfter = convoId ? await conversationBetween(studentId, mentorId) : null;
    check(!!convoAfter && !String(convoAfter.last_message_preview ?? "").includes("after the block"), "nothing was written past the block");
    await mentor.page.getByRole("button", { name: /^Unblock$/ }).first().click();
    check(
      !!(await until("the composer back after unblock", async () => (await mentor.page.getByRole("textbox", { name: /^Message / }).count()) > 0)),
      "unblock gives the mentor the composer back",
    );

    // --- report -----------------------------------------------------------------
    console.log("\nreport");
    await student.page.reload({ waitUntil: "domcontentloaded" });
    await until("the thread after reload", async () => visibleText(student.page, first));
    await student.page.getByRole("button", { name: "Conversation options" }).first().click();
    await student.page.getByRole("menuitem", { name: "Report conversation" }).first().click();
    await student.page.getByRole("textbox", { name: /reporting/i }).fill("e2e test report — safe to ignore");
    await student.page.getByRole("button", { name: /^Report$/ }).first().click();
    const reported = await until("the report row", async () => {
      const res = await fetch(`${url}/rest/v1/dm_reports?select=id&conversation_id=eq.${convoId}`, { headers: adm });
      const rows = res.ok ? await res.json() : [];
      return rows.length > 0;
    }, 15_000);
    check(!!reported, "the student reported the conversation");

    // The mentor — the person reported — is told nothing: Unsend is still
    // there on their own message, and it still works.
    await mentor.page.reload({ waitUntil: "domcontentloaded" });
    await until("the mentor's page after reload", async () => (await launcher.count()) > 0 && launcher.first().isVisible());
    if (!(await mentor.page.getByRole("dialog", { name: "Messages" }).isVisible().catch(() => false))) {
      await until("the dock after reload", async () => {
        if (await mentor.page.getByRole("dialog", { name: "Messages" }).isVisible().catch(() => false)) return true;
        await launcher.first().click().catch(() => {});
        await mentor.page.waitForTimeout(700);
        return mentor.page.getByRole("dialog", { name: "Messages" }).isVisible().catch(() => false);
      });
    }
    const dockAfter = mentor.page.getByRole("dialog", { name: "Messages" });
    await dockAfter.getByRole("button", { name: new RegExp(NAME.student) }).first().click().catch(() => {});
    await until("the reply in the reopened thread", async () => visibleText(mentor.page, reply));
    const mentorUnsend = mentor.page
      .locator("li", { has: mentor.page.getByText(reply, { exact: true }) })
      .getByRole("button", { name: "Unsend message" });
    check((await mentorUnsend.count()) > 0, "the reported person still sees Unsend (nothing tells them they were reported)");
    if ((await mentorUnsend.count()) > 0) {
      await mentorUnsend.first().click();
      await mentor.page.getByRole("button", { name: /^Unsend$/ }).first().click();
      check(
        !!(await until("the mentor's unsend", async () => !(await visibleText(mentor.page, reply)), 10_000)),
        "…and unsending works as it always did",
      );
      check((await mentor.page.getByText(/reported/i).count()) === 0, "…with no mention of a report anywhere");
    }
    const admin = await openAs(browser, sessions.admin, `/admin/messages/${convoId}`, "admin");
    check(
      !!(await until("the transcript for the admin", async () => visibleText(admin.page, first), 20_000)),
      "the admin can read the reported conversation",
    );
    check(
      (await visibleText(admin.page, reply)) && (await admin.page.getByText("unsent by sender").count()) > 0,
      "the moderator still sees what was unsent after the report, marked as unsent",
    );
    await admin.page.goto(`${BASE}/admin/messages`, { waitUntil: "domcontentloaded" });
    check(
      !!(await until("the queue row", async () => (await admin.page.getByText(new RegExp(NAME.student)).count()) > 0, 20_000)),
      "it is in the moderation queue",
    );

    // --- layout -------------------------------------------------------------------
    console.log("\nlayout");
    for (const vp of [
      { name: "phone", width: 375, height: 740 },
      { name: "desktop", width: 1280, height: 800 },
    ]) {
      const s = await openAs(browser, sessions.student, `/messages?c=${convoId}`, `student-${vp.name}`, vp);
      await until("the thread", async () => visibleText(s.page, first));
      check(await s.page.evaluate(NO_SIDEWAYS), `${vp.name}: /messages does not scroll sideways`);
      check(await onScreen(s.page, "textarea[aria-label^='Message ']"), `${vp.name}: the composer is on screen`);
      await shot(s.page, `messages-thread-${vp.name}`);
      if (vp.name === "phone") {
        await s.page.getByRole("button", { name: "Back to conversations" }).first().click().catch(() => {});
        await s.page.waitForTimeout(400);
        check(await s.page.evaluate(NO_SIDEWAYS), `${vp.name}: the conversation list does not scroll sideways`);
        await shot(s.page, `messages-list-${vp.name}`);
        await s.page.getByRole("button", { name: /^New$/ }).first().click().catch(() => {});
        const search = s.page.getByRole("textbox", { name: "Search people" });
        const box = await until("the search pane", async () => {
          const b = await search.first().boundingBox().catch(() => null);
          return b && b.width > 100 ? b : null;
        }, 10_000);
        check(!!box, `${vp.name}: "New" opens a search pane you can actually use`);
        await shot(s.page, `messages-search-${vp.name}`);
      }
      await s.ctx.close();

      const m = await openAs(browser, sessions.mentor, "/mentor", `mentor-${vp.name}`, vp);
      const l = m.page.getByRole("button", { name: /^Messages/ });
      const d = m.page.getByRole("dialog", { name: "Messages" });
      await until("the launcher", async () => (await l.count()) > 0 && l.first().isVisible());
      // The launcher is server-rendered, so it's visible before React has
      // hydrated it; a click that early does nothing. Keep pressing until the
      // panel opens.
      await until("the dock", async () => {
        if (await d.isVisible().catch(() => false)) return true;
        await l.first().click().catch(() => {});
        await m.page.waitForTimeout(700);
        return d.isVisible().catch(() => false);
      });
      check(await onScreen(m.page, "[role='dialog'][aria-label='Messages']"), `${vp.name}: the open dock fits on screen`);
      check(await m.page.evaluate(NO_SIDEWAYS), `${vp.name}: the page with the dock open does not scroll sideways`);
      await shot(m.page, `dock-open-${vp.name}`);
      await d.getByRole("button", { name: new RegExp(NAME.student) }).first().click().catch(() => {});
      await until("the dock thread", async () => visibleText(m.page, first));
      check(await onScreen(m.page, "[role='dialog'] textarea"), `${vp.name}: the dock's composer is on screen`);
      await shot(m.page, `dock-thread-${vp.name}`);
      await m.ctx.close();
    }
  } catch (err) {
    failures++;
    console.log(`  FAIL  run aborted: ${(err as Error).message}`);
  } finally {
    await browser?.close().catch(() => {});
    await cleanup();
    info("test accounts, conversations and notifications removed");
  }

  console.log(failures ? `\n${failures} check(s) FAILED — see above.\n` : "\nAll checks passed.\n");
  process.exit(failures ? 1 : 0);
}

void main();
