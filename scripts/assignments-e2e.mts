/**
 * Assignment tracker, end to end, in a real browser against a real database:
 *
 *   npm run dev                       # in another terminal
 *   npm run assignments-e2e
 *   npm run assignments-e2e -- --shots=/tmp/shots   # desktop + mobile screenshots
 *
 * A throwaway cohort (started two weeks ago) with an admin, a mentor, a student
 * and a late-entrant student. The admin creates a weekly series and a dated
 * assignment from /admin/assignments; the reminders cron fires (once); the
 * student hands in a Google Doc link; the mentor reviews it from the queue;
 * the admin's matrix shows it reviewed, excuses a missing cell, and the
 * overview shows the overdue tile. Moving the cohort's start date moves the
 * course-week deadlines except one with work handed in. Old check-in and
 * monitor URLs redirect.
 *
 * Every account and row it creates is removed in a finally block.
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
const cronSecret = required("CRON_SECRET");
const COOKIE_NAME = `sb-${new URL(url).hostname.split(".")[0]}-auth-token`;
const MAX_CHUNK = 3180;
const adm = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" };
// Random per run: an orphaned account nobody can sign in to is inert.
const PASSWORD = `e2e-${randomBytes(18).toString("base64url")}`;
const stamp = String(process.pid);

let failures = 0;
function check(cond: boolean, m: string) {
  if (cond) console.log(`  ok    ${m}`);
  else {
    failures++;
    console.log(`  FAIL  ${m}`);
  }
}

async function rest(path: string, init: RequestInit = {}) {
  const res = await fetch(`${url}/rest/v1/${path}`, {
    ...init,
    headers: { ...adm, Prefer: "return=representation", ...(init.headers ?? {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path}: ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

const users: string[] = [];
let cohortId: string | null = null;

async function reapOrphans() {
  const rows = await rest(`profiles?select=id,email&email=like.e2e-assign-*@example.invalid`);
  for (const r of rows ?? []) {
    if (!/^e2e-assign-[a-z0-9-]+@example\.invalid$/.test(r.email ?? "")) continue;
    await fetch(`${url}/auth/v1/admin/users/${r.id}`, { method: "DELETE", headers: adm }).catch(() => {});
  }
  await rest(`cohorts?name=like.E2E%20assignments%20*`, { method: "DELETE" }).catch(() => {});
}

async function createUser(kind: string, role: string, name: string): Promise<{ id: string; email: string }> {
  const email = `e2e-assign-${kind}-${stamp}@example.invalid`;
  const res = await fetch(`${url}/auth/v1/admin/users`, {
    method: "POST",
    headers: adm,
    body: JSON.stringify({ email, password: PASSWORD, email_confirm: true }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`createUser ${email}: ${JSON.stringify(body)}`);
  users.push(body.id);
  await rest(`profiles?id=eq.${body.id}`, { method: "PATCH", body: JSON.stringify({ role, full_name: name }) });
  return { id: body.id, email };
}

async function open(browser: Browser, email: string, mobile = false): Promise<{ ctx: BrowserContext; page: Page }> {
  const res = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: anonKey, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const session = await res.json();
  if (!res.ok) throw new Error(`signIn ${email}: ${JSON.stringify(session)}`);
  const value = "base64-" + Buffer.from(JSON.stringify(session), "utf8").toString("base64url");
  const cookies =
    value.length <= MAX_CHUNK
      ? [{ name: COOKIE_NAME, value }]
      : Array.from({ length: Math.ceil(value.length / MAX_CHUNK) }, (_, n) => ({
          name: `${COOKIE_NAME}.${n}`,
          value: value.slice(n * MAX_CHUNK, (n + 1) * MAX_CHUNK),
        }));
  const ctx = await browser.newContext(
    mobile
      ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, baseURL: BASE }
      : { viewport: { width: 1280, height: 900 }, baseURL: BASE },
  );
  await ctx.addCookies(cookies.map((c) => ({ ...c, url: BASE, sameSite: "Lax" as const })));
  const page = await ctx.newPage();
  // Dev servers compile on first hit; give each step room.
  page.setDefaultTimeout(90_000);
  page.on("pageerror", (e) => console.log(`        page error: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") console.log(`        console (${new URL(page.url()).pathname}): ${m.text().slice(0, 300)}`);
    if (process.env.E2E_VERBOSE && m.text().includes("hydrated")) console.log(m.text());
  });
  return { ctx, page };
}

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  // A screenshot is evidence, not a check: a slow font load must not fail the run.
  // caret "initial": hiding the caret writes inline styles into inputs, which a
  // page still hydrating in dev then reports as a hydration mismatch.
  await page
    .screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true, timeout: 30_000, caret: "initial" })
    .catch((e) => console.log(`        screenshot ${name} skipped: ${String(e).split("\n")[0]}`));
}

/** Waits for a locator to show up (the page may still be re-rendering after an action). */
async function seen(loc: ReturnType<Page["locator"]>): Promise<boolean> {
  try {
    await loc.first().waitFor({ state: "visible", timeout: 20_000 });
    return true;
  } catch {
    return false;
  }
}

async function noHorizontalScroll(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
}

/** New York wall date/time of an instant, for the admin form's date + time inputs. */
function eastern(ms: number): { date: string; time: string } {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    })
      .formatToParts(new Date(ms))
      .map((x) => [x.type, x.value]),
  );
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

async function cron(): Promise<any> {
  const res = await fetch(`${BASE}/api/cron/assignment-reminders`, { headers: { Authorization: `Bearer ${cronSecret}` } });
  return res.json();
}

async function main() {
  await reapOrphans();
  // A cohort that started on the Monday two weeks before this one (New York).
  const today = eastern(Date.now()).date;
  const dow = new Date(`${today}T12:00:00Z`).getUTCDay(); // 0 = Sunday
  const monday = new Date(Date.parse(`${today}T00:00:00Z`) - ((dow + 6) % 7) * 86_400_000);
  const startsOn = new Date(monday.getTime() - 14 * 86_400_000).toISOString().slice(0, 10);
  const endsOn = new Date(monday.getTime() + 39 * 86_400_000).toISOString().slice(0, 10);
  const [cohort] = await rest("cohorts", {
    method: "POST",
    body: JSON.stringify({ name: `E2E assignments ${stamp}`, starts_on: startsOn, ends_on: endsOn, status: "active" }),
  });
  cohortId = cohort.id as string;

  const admin = await createUser("admin", "admin", "E2E Admin");
  const mentor = await createUser("mentor", "mentor", "E2E Mentor");
  const ana = await createUser("ana", "student", "Ana Student");
  const ben = await createUser("ben", "student", "Ben Latecomer");
  await rest("enrollments", {
    method: "POST",
    body: JSON.stringify([
      { user_id: ana.id, cohort_id: cohortId, enrolled_at: new Date(Date.parse(startsOn) - 7 * 86_400_000).toISOString() },
      { user_id: ben.id, cohort_id: cohortId, enrolled_at: new Date().toISOString() },
    ]),
  });
  await rest("mentor_assignments", {
    method: "POST",
    body: JSON.stringify({ mentor_id: mentor.id, student_id: ana.id, cohort_id: cohortId }),
  });

  const browser = await chromium.launch({ headless: !headed, args: ["--disable-dev-shm-usage", "--disable-gpu", "--renderer-process-limit=2"] });
  try {
    // ---- Admin: weekly series + a dated assignment -------------------------
    const a = await open(browser, admin.email);
    await a.page.goto(`/admin/assignments?cohort=${cohortId}`);
    await a.page.getByRole("button", { name: "New assignment" }).click();
    const drawer = a.page.getByRole("dialog");
    await drawer.getByLabel("Title").fill("Weekly update");
    await drawer.getByLabel("Instructions").fill("What you shipped, what's next, what's in the way.");
    await drawer.getByLabel("Opens").selectOption("course_week");
    await drawer.getByLabel("Week", { exact: true }).selectOption("1");
    await drawer.getByLabel("Repeat weekly through week").check();
    await drawer.getByLabel("Last week").selectOption("6");
    await drawer.getByRole("button", { name: "Save" }).click();
    await drawer.waitFor({ state: "detached" });
    await a.page.waitForLoadState("networkidle");
    const series = await rest(`course_assignments?cohort_id=eq.${cohortId}&title=eq.Weekly%20update&order=week`);
    check(series.length === 6 && new Set(series.map((r: any) => r.series_id)).size === 1, "repeat weekly created weeks 1–6 as one series");

    const due = eastern(Date.now() + 20 * 3_600_000);
    await a.page.getByRole("button", { name: "New assignment" }).click();
    await drawer.getByLabel("Title").fill("Pitch deck draft");
    await drawer.getByLabel("Opens").selectOption("date");
    await drawer.getByLabel("Open date").fill(today);
    await drawer.getByLabel("Time", { exact: true }).first().fill("00:00");
    await drawer.getByLabel("Due date (optional)").fill(due.date);
    await drawer.getByLabel("Time", { exact: true }).last().fill(due.time);
    await drawer.getByLabel("Hand in").selectOption("link");
    await drawer.getByRole("button", { name: "Save" }).click();
    await drawer.waitFor({ state: "detached" });
    const [deck] = await rest(`course_assignments?cohort_id=eq.${cohortId}&title=eq.Pitch%20deck%20draft`);
    check(!!deck && deck.release_mode === "date" && deck.submission_type === "link", "dated link assignment saved");

    // ---- Esc closes the delete confirm, not the editor under it --------------
    await a.page.getByRole("button", { name: "Edit Weekly update" }).last().click();
    const editor = a.page.getByRole("dialog", { name: "Edit assignment" });
    await editor.getByRole("button", { name: "Delete" }).click();
    const confirmDelete = a.page.getByRole("dialog", { name: "Delete this assignment?" });
    await confirmDelete.waitFor();
    await a.page.keyboard.press("Escape");
    await confirmDelete.waitFor({ state: "detached" });
    check(await editor.isVisible(), "Esc in the delete confirm keeps the editor open");
    await a.page.keyboard.press("Escape");
    await editor.waitFor({ state: "detached" });

    await a.page.reload();
    const anaRow = a.page.locator("tr", { hasText: "Ana Student" });
    const benRow = a.page.locator("tr", { hasText: "Ben Latecomer" });
    check((await anaRow.getByText("Missing").count()) === 2, "matrix: Ana missing weeks 1–2");
    check((await benRow.getByText("Excused").count()) === 2, "matrix: late entrant excused from weeks 1–2");
    await shot(a.page, "admin-assignments-desktop");

    // ---- Reminders cron: once per student per assignment --------------------
    const first = await cron();
    const second = await cron();
    check(first.ok === true && first.reminded >= 2, `cron reminded students (${JSON.stringify(first)})`);
    check(second.ok === true && second.reminded === 0, "cron second run is deduped");
    const bells = await rest(`notifications?user_id=eq.${ana.id}&type=in.(assignment_released,assignment_due_soon)&select=type`);
    check(bells.some((b: any) => b.type === "assignment_due_soon"), "student got a due-soon bell");

    // ---- Student: hand in a Google Doc link ---------------------------------
    const s = await open(browser, ana.email, true);
    await s.page.goto("/dashboard/assignments");
    check((await s.page.getByText("Pitch deck draft").count()) > 0, "student list shows the dated assignment");
    check(await noHorizontalScroll(s.page), "student list fits a 390px screen");
    await shot(s.page, "student-assignments-mobile");
    await s.page.getByText("Pitch deck draft").first().click();
    await s.page.getByLabel("Link").fill("http://not-https.example.com");
    await s.page.getByRole("button", { name: "Submit" }).click();
    check(await seen(s.page.getByText("Use an https:// link.")), "http link refused");
    await s.page.getByLabel("Link").fill("https://docs.google.com/document/d/e2e-assign/edit");
    check(await seen(s.page.getByText("Anyone with the link can view")), "Drive sharing hint shown");
    await s.page.getByRole("button", { name: "Submit" }).click();
    await s.page.getByText("Submitted.", { exact: true }).waitFor();
    await s.page.getByRole("button", { name: "Update" }).waitFor();
    const [sub] = await rest(`course_assignment_submissions?assignment_id=eq.${deck.id}&user_id=eq.${ana.id}`);
    check(sub?.status === "submitted" && sub.link_url.startsWith("https://docs.google.com/"), "submission stored");
    await shot(s.page, "student-submitted-mobile");
    await s.page.goto("/app/assignments");
    check((await s.page.getByText("Pitch deck draft").count()) > 0, "installed-app tab lists assignments");
    check(await noHorizontalScroll(s.page), "installed-app tab fits a 390px screen");
    await shot(s.page, "app-assignments-mobile");

    // ---- Mentor: review from the queue --------------------------------------
    const m = await open(browser, mentor.email);
    await m.page.goto("/mentor/assignments");
    const item = m.page.locator("li", { hasText: "Pitch deck draft" }).first();
    check(await seen(item), "mentor queue shows the submission");
    await shot(m.page, "mentor-queue-desktop");
    await item.getByLabel("Feedback").fill("Strong problem slide. Tighten the ask.");
    await item.getByRole("button", { name: "Mark reviewed" }).click();
    await m.page.getByText("Nothing waiting.").waitFor();
    const [reviewed] = await rest(`course_assignment_submissions?id=eq.${sub.id}`);
    check(reviewed.status === "reviewed" && reviewed.reviewed_by === mentor.id, "review saved by the mentor");
    await m.ctx.close();

    // ---- Admin: matrix updates; excuse a missing cell -----------------------
    await a.page.reload();
    check((await anaRow.getByText("Reviewed").count()) === 1, "matrix shows the review");
    await anaRow.getByRole("button", { name: /Weekly update/ }).first().click();
    await a.page.getByRole("dialog").getByRole("button", { name: "Excuse" }).click();
    await a.page.getByRole("dialog").getByRole("button", { name: "Undo excuse" }).waitFor();
    await shot(a.page, "admin-review-drawer-desktop");
    await a.page.keyboard.press("Escape");
    await a.page.reload();
    check((await anaRow.getByText("Missing").count()) === 1, "excusing removed one missing cell");
    await a.page.goto("/admin");
    check((await a.page.getByText("Overdue assignments").count()) === 1, "overview shows the overdue tile");
    const csv = await a.page.request.get(`/admin/assignments/export?cohort=${cohortId}`);
    check(csv.ok() && (await csv.text()).includes("Ana Student"), "CSV export");

    // ---- Student sees the feedback; mobile admin -----------------------------
    await s.page.goto(`/dashboard/assignments/${deck.id}`);
    check(await seen(s.page.getByText("Tighten the ask.")), "student sees the feedback");
    const am = await open(browser, admin.email, true);
    await am.page.goto(`/admin/assignments?cohort=${cohortId}`);
    check(await noHorizontalScroll(am.page), "admin page has no page-level horizontal scroll at 390px");
    await shot(am.page, "admin-assignments-mobile");

    // ---- Moving the cohort start moves course-week dates, except handed-in ones
    const week3 = series.find((r: any) => r.week === 3);
    const week4 = series.find((r: any) => r.week === 4);
    await rest("course_assignment_submissions", {
      method: "POST",
      body: JSON.stringify({ assignment_id: week3.id, user_id: ana.id, body: "Week 3 notes", submitted_at: new Date().toISOString() }),
    });
    await a.page.goto("/admin/cohorts");
    await a.page.locator("tr", { hasText: `E2E assignments ${stamp}` }).getByRole("button", { name: "Edit", exact: true }).click();
    await a.page.getByLabel("Starts on").fill(addDays(startsOn, 7));
    check(await seen(a.page.getByText("Course-week assignment dates move too")), "cohort form says course-week dates move");
    await a.page.getByRole("button", { name: "Save cohort" }).click();
    await a.page.getByRole("button", { name: "New cohort" }).waitFor();
    const [w3] = await rest(`course_assignments?id=eq.${week3.id}`);
    const [w4] = await rest(`course_assignments?id=eq.${week4.id}`);
    check(Date.parse(w3.due_at) === Date.parse(week3.due_at), "a week with work handed in keeps its deadline");
    const before = eastern(Date.parse(week4.due_at));
    const after = eastern(Date.parse(w4.due_at));
    check(after.date === addDays(before.date, 7) && after.time === before.time, "a week without work moves with the start date");

    // ---- Old check-in URLs ----------------------------------------------------
    await s.page.goto("/dashboard/checkin");
    check(new URL(s.page.url()).pathname === "/dashboard/assignments", "/dashboard/checkin redirects");
    await a.page.goto("/admin/interventions");
    const landed = new URL(a.page.url());
    check(landed.pathname === "/admin/assignments" && landed.searchParams.get("filter") === "missing", "/admin/interventions redirects to the missing filter");
  } catch (err) {
    // Leave a picture of every open page behind for whoever reads the failure.
    let n = 0;
    for (const ctx of browser.contexts()) for (const p of ctx.pages()) await shot(p, `failure-${++n}`);
    throw err;
  } finally {
    await browser.close();
    // Accounts first (their enrollments, submissions and bells cascade), then the cohort.
    for (const id of users) {
      await fetch(`${url}/auth/v1/admin/users/${id}`, { method: "DELETE", headers: adm }).catch(() => {});
    }
    if (cohortId) await rest(`cohorts?id=eq.${cohortId}`, { method: "DELETE" }).catch(() => {});
  }
}

main()
  .then(() => {
    console.log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed.");
    process.exit(failures ? 1 : 0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
