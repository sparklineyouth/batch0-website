/**
 * Verify the imported launch course through a local production build and real RLS.
 * Run only after the reviewed curriculum manifest has been imported:
 *   node --env-file=.env.local scripts/course-launch-smoke.mts http://localhost:3102 --browser
 *
 * Creates one confirmed, ordinary student at a unique .invalid address via the
 * auth admin API (no signup email), briefly enrolls it, then deletes the fixture
 * and any outbox rows addressed to it. Never uses a real student's session,
 * creates an application/payment, enters Daily, or calls an email/cron endpoint.
 * The reviewed manifest is private and intentionally excluded from the public
 * repository. Set COURSE_LAUNCH_MANIFEST to its local path when using a clean
 * checkout; otherwise the private content/course-launch/manifest.json is used.
 * This is an operator integration check, not a credential-free CI unit test.
 * --browser also checks the public starter worksheet using installed Chrome.
 */
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

type ModuleRow = { id: string; title: string; week: number; position: number };
type LessonRow = {
  id: string; module_id: string; title: string; description: string; position: number;
  materials: { title: string; path: string }[];
};
type Asset = { bucket: string; path: string; sha256: string; size_bytes: number };
type Manifest = {
  cohort: { id: string }; modules: ModuleRow[]; lessons: LessonRow[]; assets: Asset[];
};

const base = new URL(process.argv.find((arg) => /^https?:/.test(arg)) ?? process.env.E2E_BASE_URL ?? "http://localhost:3102");
assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(base.hostname), "Only a local development server is allowed");
assert.equal(base.username + base.password + base.search + base.hash, "", "Use a plain localhost origin");
const required = (key: string) => {
  const value = process.env[key];
  assert.ok(value, `Missing ${key}; load .env.local without printing its contents`);
  return value;
};
const supabase = new URL(required("NEXT_PUBLIC_SUPABASE_URL"));
const serviceKey = required("SUPABASE_SERVICE_ROLE_KEY");
const anonKey = required("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const adminHeaders = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" };
const publicHeaders = { apikey: anonKey, "Content-Type": "application/json" };
const manifestPath = process.env.COURSE_LAUNCH_MANIFEST ?? new URL("../content/course-launch/manifest.json", import.meta.url);
const manifest: Manifest = JSON.parse(await readFile(manifestPath, "utf8").catch(() => {
  throw new Error("This operator test requires the private reviewed manifest. Set COURSE_LAUNCH_MANIFEST to that local JSON file; it is not committed to the public repository.");
}));
assert.equal(manifest.modules.length, 9);
assert.equal(manifest.lessons.length, 37);
const modules = [...manifest.modules].sort((a, b) => a.week - b.week || a.position - b.position);
const lessons = modules.flatMap((module) => manifest.lessons.filter((lesson) => lesson.module_id === module.id).sort((a, b) => a.position - b.position));
const firstLesson = lessons[0];
const eventId = "1bbfd694-24be-4c83-a450-ff85c06716a0";
const email = `course-launch-qa-${randomUUID()}@example.invalid`;
const password = randomBytes(32).toString("base64url");
let fixtureId: string | undefined;
let checks = 0;

function passed(name: string) { checks++; console.log(`ok ${name}`); }
async function request(target: URL | string, init: RequestInit = {}) {
  const destination = new URL(target);
  assert.ok(destination.origin === base.origin || destination.origin === supabase.origin, "Requests stay on localhost or the configured Supabase project");
  return fetch(destination, { ...init, redirect: "manual", signal: AbortSignal.timeout(30_000) });
}
async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await request(new URL(path, supabase), { ...init, headers: init.headers ?? adminHeaders });
  assert.ok(response.ok, `Supabase ${init.method ?? "GET"} ${path.split("?")[0]} returned ${response.status}`);
  const body = await response.text();
  return body ? JSON.parse(body) as T : undefined as T;
}
async function page(path: string, cookie = "") {
  const response = await request(new URL(path, base), { headers: cookie ? { cookie } : undefined });
  return { status: response.status, body: await response.text(), headers: response.headers };
}
function cookieFor(session: unknown) {
  const name = `sb-${supabase.hostname.split(".")[0]}-auth-token`;
  const value = `base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}`;
  if (value.length <= 3180) return `${name}=${value}`;
  const pieces = [];
  for (let offset = 0; offset < value.length; offset += 3180) pieces.push(`${name}.${offset / 3180}=${value.slice(offset, offset + 3180)}`);
  return pieces.join("; ");
}
function decodeHtml(value: string) {
  return value.replace(/&#x([a-f0-9]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, digits) => String.fromCodePoint(Number(digits)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}
function visibleText(html: string) {
  return decodeHtml(html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "").replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "").replace(/<!--[^]*?-->/g, "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");
}
function hrefs(html: string) { return [...html.matchAll(/\bhref="([^"]+)"/g)].map((match) => decodeHtml(match[1])); }
function noPrivateMaterial(html: string) {
  assert.ok(!html.includes("/storage/v1/object/sign/course-materials/"), "Unauthorized page must not mint private material URLs");
  assert.ok(!html.includes(firstLesson.title), "Unauthorized page must not expose lesson content");
}

// All preflight failures happen before fixture creation.
assert.equal((await page("/start")).status, 200, "Start the combined production build first");
const liveModules = await api<ModuleRow[]>(`/rest/v1/modules?select=id,title,week,position&cohort_id=eq.${manifest.cohort.id}`);
assert.deepEqual(liveModules.map((row) => row.id).sort(), modules.map((row) => row.id).sort(), "Import all nine modules before running this test");
const lessonFilter = `module_id=in.(${modules.map((module) => module.id).join(",")})`;
const liveLessons = await api<LessonRow[]>(`/rest/v1/lessons?select=id,module_id,title,description,position,materials&${lessonFilter}`);
assert.deepEqual(liveLessons.map((row) => row.id).sort(), lessons.map((row) => row.id).sort(), "Import all 37 lessons before running this test");
for (const lesson of lessons) {
  const live = liveLessons.find((row) => row.id === lesson.id);
  assert.equal(live?.description, lesson.description, `Imported lesson matches reviewed source: ${lesson.title}`);
  assert.deepEqual(live?.materials, lesson.materials, `Imported material links match source: ${lesson.title}`);
}
passed("Imported curriculum matches all nine modules and 37 reviewed lessons");

try {
  const user = await api<{ id: string }>("/auth/v1/admin/users", {
    method: "POST", body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { full_name: "Course launch QA" } }),
  });
  fixtureId = user.id;
  assert.ok(fixtureId, "Auth fixture creation returned its ID");
  console.log(`Fixture created: ${fixtureId} (${email}); always deleted in finally`);
  const profiles = await api<{ role: string }[]>(`/rest/v1/profiles?select=role&id=eq.${fixtureId}`);
  assert.equal(profiles[0]?.role, "student", "Fixture must have ordinary student permissions");
  const session = await api<{ access_token: string; user: { id: string } }>("/auth/v1/token?grant_type=password", {
    method: "POST", headers: publicHeaders, body: JSON.stringify({ email, password }),
  });
  assert.equal(session.user.id, fixtureId);
  const cookie = cookieFor(session);
  const studentHeaders = { ...publicHeaders, Authorization: `Bearer ${session.access_token}` };
  const login = await page("/login", cookie);
  assert.ok([303, 307, 308].includes(login.status));
  assert.equal(new URL(login.headers.get("location") ?? "", base).pathname, "/dashboard");
  passed("Confirmed throwaway account authenticates with ordinary student permissions");

  const anonCourse = await page("/dashboard/course");
  assert.ok([303, 307, 308].includes(anonCourse.status));
  noPrivateMaterial(anonCourse.body);
  const locked = await page("/dashboard/course", cookie);
  assert.equal(locked.status, 200);
  assert.match(visibleText(locked.body), /Course access unlocks once you're enrolled/);
  noPrivateMaterial(locked.body);
  const lockedLesson = await page(`/dashboard/course/${firstLesson.id}`, cookie);
  // Next can send 200 before a streamed notFound; the robots marker is its fallback.
  assert.ok(lockedLesson.status === 404 || (lockedLesson.body.includes("noindex") && lockedLesson.body.includes("NEXT_HTTP_ERROR_FALLBACK;404")), `Unenrolled lesson must be hidden: HTTP ${lockedLesson.status}, noindex ${lockedLesson.body.includes("noindex")}, streamed 404 ${lockedLesson.body.includes("NEXT_HTTP_ERROR_FALLBACK;404")}`);
  noPrivateMaterial(lockedLesson.body);
  const hiddenLessons = await api<unknown[]>(`/rest/v1/lessons?select=id&${lessonFilter}`, { headers: studentHeaders });
  assert.equal(hiddenLessons.length, 0);
  const lockedKickoff = await page("/dashboard/kickoff", cookie);
  assert.ok([303, 307, 308].includes(lockedKickoff.status) || (lockedKickoff.status === 200 && lockedKickoff.body.includes("NEXT_REDIRECT;replace;/dashboard;")), "Unenrolled kickoff redirects to the student dashboard, including after streaming begins");
  assert.ok(!hrefs(lockedKickoff.body).some((href) => href.includes(`/dashboard/events/${eventId}/live`)));
  assert.equal((await page(`/api/events/${eventId}/ics`, cookie)).status, 404);
  passed("Anonymous and unenrolled visitors cannot read the course, kickoff, or enrolled calendar");

  await api("/rest/v1/enrollments", {
    method: "POST", headers: { ...adminHeaders, Prefer: "return=minimal" },
    body: JSON.stringify({ user_id: fixtureId, cohort_id: manifest.cohort.id }),
  });
  const enrolledModules = await api<ModuleRow[]>(`/rest/v1/modules?select=id&cohort_id=eq.${manifest.cohort.id}`, { headers: studentHeaders });
  const enrolledLessons = await api<LessonRow[]>(`/rest/v1/lessons?select=id&${lessonFilter}`, { headers: studentHeaders });
  assert.equal(enrolledModules.length, 9);
  assert.equal(enrolledLessons.length, 37);
  const course = await page("/dashboard/course", cookie);
  assert.equal(course.status, 200);
  assert.match(visibleText(course.body), /37 lessons · 0 completed/);
  const courseLinks = new Set(hrefs(course.body).filter((href) => /^\/dashboard\/course\/[a-f0-9-]+$/.test(href)));
  assert.deepEqual([...courseLinks].sort(), lessons.map((lesson) => `/dashboard/course/${lesson.id}`).sort());
  for (const module of modules) assert.ok(visibleText(course.body).includes(module.title), `Course contains ${module.title}`);
  passed("Enrollment unlocks all nine modules and exactly 37 navigable lessons");

  const pdfUrls = new Map<string, string>();
  // Bound concurrent rendering while checking every lesson and cross-week navigation.
  for (let offset = 0; offset < lessons.length; offset += 4) {
    await Promise.all(lessons.slice(offset, offset + 4).map(async (lesson, indexInBatch) => {
      const result = await page(`/dashboard/course/${lesson.id}`, cookie);
      assert.equal(result.status, 200, `${lesson.title} loads`);
      const article = result.body.match(/<article\b[^>]*aria-label="Lesson and exercises"[^>]*>([\s\S]*?)<\/article>/)?.[1];
      assert.ok(article, `${lesson.title} has a lesson article`);
      assert.match(article, /<h2\b[^>]*>Goal<\/h2>/);
      assert.match(article, /<h3\b[^>]*>Do it now<\/h3>/);
      assert.match(article, /<h3\b[^>]*>Check yourself<\/h3>/);
      assert.match(article, /<ol>/, `${lesson.title} renders exercises as a list`);
      assert.match(visibleText(result.body), /Mark complete|Completed/);
      const links = hrefs(result.body);
      const next = lessons[offset + indexInBatch + 1];
      if (next) {
        assert.ok(links.includes(`/dashboard/course/${next.id}`), `${lesson.title} links to the next lesson`);
        assert.match(visibleText(result.body), /Next lesson/);
      } else assert.ok(!visibleText(result.body).includes("Next lesson"), "Final lesson does not loop");
      for (const material of lesson.materials.filter((item) => item.path.endsWith(".pdf"))) {
        const signed = links.find((href) => {
          if (!href.startsWith(supabase.origin)) return false;
          return decodeURIComponent(new URL(href).pathname) === `/storage/v1/object/sign/course-materials/${material.path}`;
        });
        assert.ok(signed, `${lesson.title} provides its signed workbook PDF`);
        assert.ok(new URL(signed).searchParams.has("token"));
        pdfUrls.set(material.path, signed);
      }
    }));
  }
  passed("All 37 lessons render headings, exercises, completion controls, and correct next links");

  assert.equal(pdfUrls.size, 9, "Each week provides a workbook PDF");
  for (const [path, signed] of pdfUrls) {
    const response = await request(signed);
    assert.equal(response.status, 200, `Signed workbook download succeeds: ${path}`);
    assert.match(response.headers.get("content-type") ?? "", /application\/pdf/);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.subarray(0, 5).toString(), "%PDF-");
    const asset = manifest.assets.find((item) => item.bucket === "course-materials" && item.path === path);
    assert.ok(asset, "Downloaded workbook exists in the reviewed manifest");
    assert.equal(createHash("sha256").update(bytes).digest("hex"), asset.sha256, `Downloaded PDF matches reviewed artifact: ${path}`);
    for (const accessPath of ["public/", ""]) {
      const anonymous = await request(new URL(`/storage/v1/object/${accessPath}course-materials/${path}`, supabase), { headers: publicHeaders });
      assert.ok([400, 401, 403, 404].includes(anonymous.status), `Anonymous direct access stays blocked: ${path}`);
      assert.ok(!Buffer.from(await anonymous.arrayBuffer()).subarray(0, 5).equals(Buffer.from("%PDF-")));
    }
  }
  passed("All nine private PDF downloads match their reviewed files; anonymous storage reads are denied");

  const kickoff = await page("/dashboard/kickoff", cookie);
  assert.equal(kickoff.status, 200);
  assert.ok(hrefs(kickoff.body).some((href) => href.includes(`/dashboard/events/${eventId}/live`)), "Kickoff points to the prepared hosted event");
  const calendar = await page(`/api/events/${eventId}/ics`, cookie);
  assert.equal(calendar.status, 200);
  assert.match(calendar.headers.get("content-type") ?? "", /text\/calendar/);
  for (const expected of [`UID:${eventId}@batch0.org`, "DTSTART:20260915T000000Z", "DTEND:20260915T010000Z", `/dashboard/events/${eventId}/live`]) assert.ok(calendar.body.includes(expected));
  assert.ok(calendar.body.endsWith("END:VCALENDAR\r\n"));
  assert.ok(!calendar.body.includes("daily.co"), "Calendar shares the authenticated join page");
  passed("Kickoff and downloadable calendar point to September 14, 8–9 pm EDT");

  const completedAt = new Date().toISOString();
  await api("/rest/v1/lesson_progress?on_conflict=user_id,lesson_id", {
    method: "POST", headers: { ...studentHeaders, Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ user_id: fixtureId, lesson_id: firstLesson.id, watched_seconds: 0, completed_at: completedAt }),
  });
  const progress = await api<{ completed_at: string }[]>(`/rest/v1/lesson_progress?select=completed_at&user_id=eq.${fixtureId}&lesson_id=eq.${firstLesson.id}`, { headers: studentHeaders });
  assert.equal(new Date(progress[0]?.completed_at).getTime(), new Date(completedAt).getTime());
  const reloadedLesson = await page(`/dashboard/course/${firstLesson.id}`, cookie);
  assert.match(visibleText(reloadedLesson.body), /Completed/);
  assert.match(visibleText((await page("/dashboard/course", cookie)).body), /37 lessons · 1 completed/);
  passed("Student completion persists through RLS and reloads in both lesson and course views");

  // Confirm revocation takes effect even while the student's session is valid.
  await api(`/rest/v1/enrollments?user_id=eq.${fixtureId}&cohort_id=eq.${manifest.cohort.id}`, { method: "DELETE" });
  const revoked = await page("/dashboard/course", cookie);
  assert.match(visibleText(revoked.body), /Course access unlocks once you're enrolled/);
  noPrivateMaterial(revoked.body);
  assert.equal((await api<unknown[]>(`/rest/v1/lessons?select=id&${lessonFilter}`, { headers: studentHeaders })).length, 0);
  passed("Removing the temporary enrollment immediately revokes course access");
} finally {
  if (fixtureId) {
    // Outbox.user_id uses ON DELETE SET NULL, so match the unique fixture email
    // as well. Nothing can match a real recipient or another test fixture.
    const outboxFilter = `or=(user_id.eq.${fixtureId},to_email.eq.${email})`;
    let cleanupError: unknown;
    try { await api(`/rest/v1/email_outbox?${outboxFilter}`, { method: "DELETE" }); }
    catch (error) { cleanupError = error; }
    try {
      await api(`/auth/v1/admin/users/${fixtureId}`, { method: "DELETE" });
      const absent = await request(new URL(`/auth/v1/admin/users/${fixtureId}`, supabase), { headers: adminHeaders });
      assert.equal(absent.status, 404, "Temporary auth user was deleted");
      // Repeat after deletion to cover an enrollment-targeting cron race.
      await api(`/rest/v1/email_outbox?${outboxFilter}`, { method: "DELETE" });
      for (const table of ["profiles", "enrollments", "lesson_progress", "email_outbox"]) {
        const filter: string = table === "profiles" ? `id=eq.${fixtureId}` : table === "email_outbox" ? outboxFilter : `user_id=eq.${fixtureId}`;
        assert.equal((await api<unknown[]>(`/rest/v1/${table}?select=*&${filter}`)).length, 0, `Fixture ${table} rows were removed`);
      }
      passed("Temporary auth user, enrollment, progress, profile, and any fixture outbox rows are removed");
    } catch (error) {
      throw new Error(`Fixture cleanup needs attention for ${fixtureId} (${email})`, { cause: error });
    }
    if (cleanupError) throw new Error("Initial fixture outbox cleanup failed; final cleanup succeeded", { cause: cleanupError });
  }
}

if (process.argv.includes("--browser")) {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ["clipboard-read", "clipboard-write"], acceptDownloads: true });
    await context.route("**/*", async (route) => {
      if (new URL(route.request().url()).origin === base.origin) await route.continue();
      else await route.abort();
    });
    const tab = await context.newPage();
    const errors: string[] = [];
    tab.on("pageerror", (error) => errors.push(error.message));
    assert.equal((await tab.goto(new URL("/start", base).href))?.status(), 200);
    await tab.getByRole("button", { name: "Copy the worksheet", exact: true }).first().click();
    await tab.getByRole("button", { name: "Worksheet copied", exact: true }).waitFor();
    const copied = await tab.evaluate(() => navigator.clipboard.readText());
    assert.ok(copied.includes("MY NEXT SEVEN DAYS"));
    const [download] = await Promise.all([tab.waitForEvent("download"), tab.getByRole("link", { name: "Download .txt", exact: true }).first().click()]);
    assert.equal(download.suggestedFilename(), "batch0-founder-starter-worksheet.txt");
    assert.equal(await download.failure(), null);
    const downloadedPath = await download.path();
    assert.ok(downloadedPath);
    assert.equal(await readFile(downloadedPath, "utf8"), copied);
    assert.ok(await tab.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "Starter kit fits mobile width");
    assert.deepEqual(errors, [], "Starter kit has no browser runtime errors");
    await tab.screenshot({ path: "/tmp/batch0-start-react19-mobile.png", fullPage: true });
    passed("React 19 starter kit copies and downloads the complete worksheet without mobile overflow");
  } finally { await browser.close(); }
}

console.log(`Course launch smoke passed: ${checks} checks; no emails, payments, or live-room tokens requested.`);
