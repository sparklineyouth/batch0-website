/**
 * What the October 2026 revamp retired still has to reach the people it
 * belongs to. Drives a running dev server over HTTP as real users:
 *
 *   npm run dev                  # in another terminal
 *   npm run carryover-e2e
 *
 * Checks, each against rows this script seeds:
 *   - /admin/progress counts a handed-in assignment as activity (not "never
 *     started");
 *   - weeks-1–4 check-ins and their mentor feedback show, read-only, to the
 *     student, their mentor and an admin;
 *   - an office-hours session booked before the cut shows on both people's
 *     calls pages with its Zoom link and the mentor's notes; a mentor-panel
 *     role without calls.invite sees its own on /mentor, with a meeting
 *     field that isn't a link shown as text;
 *   - the logo review queue sits on /admin/teams, open to a moderator without
 *     teams.manage, and founder-pass feedback requests sit on /admin/passes;
 *     the old URLs and the retired staff queues redirect;
 *   - a role whose only keys were retired is flagged on /admin/roles, and its
 *     members get "Nothing to open yet" on /dashboard.
 *
 * Every account, role and row it creates is removed in a finally block.
 */

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3000";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing ${name}. Run via npm so .env.local is loaded.`);
    process.exit(1);
  }
  return value;
}

const url = required("NEXT_PUBLIC_SUPABASE_URL");
const serviceKey = required("SUPABASE_SERVICE_ROLE_KEY");
const anonKey = required("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const COOKIE_NAME = `sb-${new URL(url).hostname.split(".")[0]}-auth-token`;
const MAX_CHUNK = 3180;
const adm = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" };
const PASSWORD = `e2e-${crypto.randomUUID()}`;
const stamp = process.env.E2E_STAMP ?? String(process.pid);
const DAY = 86_400_000;

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail && !ok ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
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
const insert = async (table: string, row: unknown) => (await rest(table, { method: "POST", body: JSON.stringify(row) }))[0];

const users: string[] = [];
const roles: string[] = [];
let cohortId: string | null = null;

async function createUser(kind: string, role: string, name: string): Promise<{ id: string; email: string }> {
  const email = `e2e-carry-${kind}-${stamp}@example.invalid`;
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

async function cookieFor(email: string): Promise<string> {
  const res = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: anonKey, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const session = await res.json();
  if (!res.ok) throw new Error(`signIn ${email}: ${JSON.stringify(session)}`);
  const value = "base64-" + Buffer.from(JSON.stringify(session), "utf8").toString("base64url");
  if (value.length <= MAX_CHUNK) return `${COOKIE_NAME}=${value}`;
  const parts: string[] = [];
  for (let i = 0, n = 0; i < value.length; i += MAX_CHUNK, n++) {
    parts.push(`${COOKIE_NAME}.${n}=${value.slice(i, i + MAX_CHUNK)}`);
  }
  return parts.join("; ");
}

/** One request, redirects not followed. */
async function get(cookie: string, path: string) {
  const res = await fetch(`${BASE}${path}`, { headers: { cookie }, redirect: "manual" });
  const location = res.headers.get("location");
  const body = res.status === 200 ? await res.text() : "";
  const to = location ? new URL(location, BASE) : null;
  return { status: res.status, to: to ? to.pathname : null, search: to?.search ?? "", body };
}

/** The <tr> of a table whose text mentions `needle`, or "". */
function rowWith(html: string, needle: string): string {
  // Drop scripts first: the RSC payload repeats every row's data, and when a
  // streamed page flushes it ahead of the table it lands in the chunk before
  // the first <tr>, so that chunk would "mention" everyone. Then cut at </tr>.
  return html
    .replace(/<script\b[\s\S]*?<\/script>/g, "")
    .split("<tr")
    .map((chunk) => chunk.split("</tr>")[0])
    .find((row) => row.includes(needle)) ?? "";
}

async function main() {
  // A cohort that started two weeks ago and is running.
  const startsOn = new Date(Date.now() - 14 * DAY).toISOString().slice(0, 10);
  const endsOn = new Date(Date.now() + 40 * DAY).toISOString().slice(0, 10);
  const cohort = await insert("cohorts", { name: `E2E carryover ${stamp}`, starts_on: startsOn, ends_on: endsOn, status: "active" });
  cohortId = cohort.id;

  // Custom roles: a moderator without teams.manage, and one stranded by
  // retired keys (as a role built before the revamp would be).
  const modSlug = `e2e-mod-${stamp}`.slice(0, 32);
  const strandedSlug = `e2e-strand-${stamp}`.slice(0, 32);
  await insert("app_roles", { slug: modSlug, label: "E2E moderator", permissions: ["moderation.manage"], home_path: "/admin" });
  roles.push(modSlug);
  await insert("app_roles", { slug: strandedSlug, label: "E2E stranded", permissions: ["pulse.view", "discussions.manage"], home_path: "/admin" });
  roles.push(strandedSlug);
  // A mentor-panel role without calls.invite (the old office-hours page
  // needed only the panel).
  const panelSlug = `e2e-mpanel-${stamp}`.slice(0, 32);
  await insert("app_roles", { slug: panelSlug, label: "E2E panel mentor", permissions: ["mentor.panel"], home_path: "/mentor" });
  roles.push(panelSlug);

  const admin = await createUser("admin", "admin", "E2E Carry Admin");
  const mentor = await createUser("mentor", "mentor", "Mira Carryover");
  const cara = await createUser("cara", "student", "Cara Carryover");
  const sid = await createUser("sid", "student", "Sid Submitter");
  const mod = await createUser("mod", modSlug, "E2E Moderator");
  const stranded = await createUser("strand", strandedSlug, "E2E Stranded");
  const panel = await createUser("panel", panelSlug, "Pat Panel");

  await rest("enrollments", {
    method: "POST",
    body: JSON.stringify([
      { user_id: cara.id, cohort_id: cohortId },
      { user_id: sid.id, cohort_id: cohortId },
    ]),
  });
  await insert("mentor_assignments", { mentor_id: mentor.id, student_id: cara.id, cohort_id: cohortId });

  // Sid's only activity: one handed-in assignment.
  const assignment = await insert("course_assignments", {
    cohort_id: cohortId,
    title: `Carryover update ${stamp}`,
    release_mode: "now",
    status: "published",
    submission_type: "text",
  });
  await insert("course_assignment_submissions", {
    assignment_id: assignment.id,
    user_id: sid.id,
    body: "Shipped it.",
    status: "submitted",
    submitted_at: new Date(Date.now() - 2 * DAY).toISOString(),
  });

  // A week-2 check-in with mentor feedback (never carried into assignments).
  const checkin = await insert("student_checkins", {
    user_id: cara.id,
    cohort_id: cohortId,
    week_start: new Date(Date.now() - 10 * DAY).toISOString().slice(0, 10),
    accomplished: `carry-did-${stamp}`,
    blockers: `carry-blocker-${stamp}`,
  });
  await insert("checkin_feedback", { checkin_id: checkin.id, author_id: mentor.id, body: `carry-feedback-${stamp}` });

  // An office-hours session booked before the cut, two days out.
  const slot = await insert("mentor_slots", {
    mentor_id: mentor.id,
    starts_at: new Date(Date.now() + 2 * DAY).toISOString(),
    ends_at: new Date(Date.now() + 2 * DAY + 30 * 60_000).toISOString(),
    zoom_url: `https://zoom.us/j/${stamp}`,
    notes: `carry-note-${stamp}`,
  });
  await insert("mentor_bookings", { slot_id: slot.id, student_id: cara.id, topic: `carry-topic-${stamp}`, status: "booked" });
  // One whose "link" was free text, as the old form allowed.
  const textSlot = await insert("mentor_slots", {
    mentor_id: panel.id,
    starts_at: new Date(Date.now() + 3 * DAY).toISOString(),
    ends_at: new Date(Date.now() + 3 * DAY + 30 * 60_000).toISOString(),
    zoom_url: `Room 204 carry-${stamp}`,
  });
  await insert("mentor_bookings", { slot_id: textSlot.id, student_id: cara.id, topic: null, status: "booked" });

  // A team logo waiting for review, and a redeemed feedback credit.
  const team = await insert("teams", {
    cohort_id: cohortId,
    name: `E2E Carry Team ${stamp}`,
    slug: `e2e-carry-team-${stamp}`,
    logo_url: `https://example.invalid/storage/v1/object/public/team-logos/e2e-${stamp}.png`,
    logo_status: "pending",
  });
  await insert("founder_pass_feedback_requests", {
    user_id: cara.id,
    topic: "pitch_deck",
    detail: `carry-request-${stamp}`,
    status: "requested",
  });

  const asAdmin = await cookieFor(admin.email);
  const asMentor = await cookieFor(mentor.email);
  const asCara = await cookieFor(cara.email);
  const asMod = await cookieFor(mod.email);
  const asStranded = await cookieFor(stranded.email);
  const asPanel = await cookieFor(panel.email);

  console.log(`\nBase URL: ${BASE}\n\nprogress board\n`);
  const progress = await get(asAdmin, `/admin/progress?cohort=${cohortId}`);
  const sidRow = rowWith(progress.body, "Sid Submitter");
  check("Sid is on the board", progress.status === 200 && sidRow !== "", String(progress.status));
  check(
    "handing in work counts: not 'never started'",
    !sidRow.includes("never started"),
    sidRow.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 300),
  );
  check("stopped at names the assignment", sidRow.includes(`Carryover update ${stamp}`));
  const caraRow = rowWith(progress.body, "Cara Carryover");
  check("a student with no activity is still 'never started'", caraRow.includes("never started"));

  console.log("\nearlier check-ins\n");
  for (const [who, cookie, path] of [
    ["admin", asAdmin, `/admin/students/${cara.id}`],
    ["mentor", asMentor, `/mentor/students/${cara.id}`],
    ["student", asCara, "/dashboard/assignments"],
  ] as const) {
    const r = await get(cookie, path);
    check(
      `${who} sees Earlier check-ins with the blocker and the feedback`,
      r.status === 200 &&
        r.body.includes("Earlier check-ins") &&
        r.body.includes(`carry-blocker-${stamp}`) &&
        r.body.includes(`carry-feedback-${stamp}`) &&
        r.body.includes("Mira Carryover"),
      `${r.status}${r.to ? ` → ${r.to}` : ""}`,
    );
  }
  const sidHistory = await get(asAdmin, `/admin/students/${sid.id}`);
  check("no check-ins, no section", sidHistory.status === 200 && !sidHistory.body.includes("Earlier check-ins"));

  console.log("\noffice hours booked before the cut\n");
  const studentCalls = await get(asCara, "/dashboard/calls");
  check(
    "student's calls page lists it with the mentor and the Zoom link",
    studentCalls.status === 200 &&
      studentCalls.body.includes("Office hours already booked") &&
      studentCalls.body.includes(`carry-topic-${stamp}`) &&
      studentCalls.body.includes("Mira Carryover") &&
      studentCalls.body.includes(`href="https://zoom.us/j/${stamp}"`) &&
      studentCalls.body.includes(`carry-note-${stamp}`),
    String(studentCalls.status),
  );
  check(
    "…and a meeting field that isn't a link as text, never an href",
    studentCalls.body.includes(`Room 204 carry-${stamp}`) &&
      !studentCalls.body.includes(`href="Room 204`) &&
      studentCalls.body.includes("No join link; see the details"),
  );
  const mentorCalls = await get(asMentor, "/mentor/calls");
  check(
    "mentor's calls page lists it with the student",
    mentorCalls.status === 200 &&
      mentorCalls.body.includes("Office hours already booked") &&
      mentorCalls.body.includes("Cara Carryover") &&
      mentorCalls.body.includes(`href="https://zoom.us/j/${stamp}"`) &&
      mentorCalls.body.includes(`carry-note-${stamp}`),
    String(mentorCalls.status),
  );
  const mentorHome = await get(asMentor, "/mentor");
  check("…and not again on /mentor", mentorHome.status === 200 && !mentorHome.body.includes("Office hours already booked"));
  const panelCalls = await get(asPanel, "/mentor/calls");
  // app/mentor/loading.tsx streams the shell first, so the guard's redirect
  // can arrive inside a 200 rather than as a 307.
  check(
    "a mentor-panel role without calls.invite can't open /mentor/calls",
    panelCalls.to === "/mentor" || (panelCalls.status === 200 && /NEXT_REDIRECT;(replace|push);\/mentor;/.test(panelCalls.body)),
    `${panelCalls.status} → ${panelCalls.to}`,
  );
  const panelHome = await get(asPanel, "/mentor");
  check(
    "…so its bookings are on /mentor",
    panelHome.status === 200 &&
      panelHome.body.includes("Office hours already booked") &&
      panelHome.body.includes("Cara Carryover") &&
      panelHome.body.includes(`Room 204 carry-${stamp}`),
    String(panelHome.status),
  );
  const oldLink = await get(asCara, "/dashboard/office-hours");
  check("old office-hours link lands on calls", oldLink.to === "/dashboard/calls", `${oldLink.status} → ${oldLink.to}`);

  console.log("\nfolded admin queues\n");
  const modTeams = await get(asMod, "/admin/teams");
  check(
    "moderator without teams.manage opens /admin/teams and sees the logo queue",
    modTeams.status === 200 && modTeams.body.includes("Logos to review") && modTeams.body.includes(`E2E Carry Team ${stamp}`),
    `${modTeams.status}${modTeams.to ? ` → ${modTeams.to}` : ""}`,
  );
  check("…but not the team list or New team", !modTeams.body.includes("/admin/teams/new") && !modTeams.body.includes(`href="/admin/teams/${team.id}"`));
  check("…and the sidebar shows Teams, no Moderation row", modTeams.body.includes('href="/admin/teams"') && !modTeams.body.includes('href="/admin/moderation"'));
  const modTeam = await get(asMod, `/admin/teams/${team.id}`);
  check("a team's own page still needs teams.manage", modTeam.status === 307 && modTeam.to === "/admin", `${modTeam.status} → ${modTeam.to}`);
  const adminTeams = await get(asAdmin, "/admin/teams");
  check(
    "admin sees the queue above the team list",
    adminTeams.status === 200 && adminTeams.body.includes("Logos to review") && adminTeams.body.includes("/admin/teams/new"),
  );
  const passes = await get(asAdmin, "/admin/passes");
  check(
    "feedback requests sit on /admin/passes",
    passes.status === 200 && passes.body.includes("Feedback requests") && passes.body.includes(`carry-request-${stamp}`),
    String(passes.status),
  );
  for (const [from, to] of [
    ["/admin/moderation", "/admin/teams"],
    ["/admin/pass-requests", "/admin/passes"],
    ["/admin/discussions/00000000-0000-0000-0000-000000000000", "/admin/support"],
    ["/admin/messages/00000000-0000-0000-0000-000000000000", "/admin/support"],
  ]) {
    const r = await get(asAdmin, from);
    check(`${from} → ${to}`, (r.status === 308 || r.status === 307) && r.to === to, `${r.status} → ${r.to}`);
  }
  const ask = await get(asCara, "/dashboard/discussions/new?to=team");
  check(
    "a student's 'ask the team' link opens a new support request",
    ask.to === "/dashboard/support/new" && ask.search.includes("topic=program"),
    `${ask.status} → ${ask.to}${ask.search}`,
  );

  console.log("\nrole stranded by retired keys\n");
  const strandedLogin = await get(asStranded, "/login");
  check("lands on /dashboard, not /admin", strandedLogin.to === "/dashboard", `${strandedLogin.status} → ${strandedLogin.to}`);
  const strandedHome = await get(asStranded, "/dashboard");
  check("/dashboard says there's nothing to open", strandedHome.status === 200 && strandedHome.body.includes("Nothing to open yet"), String(strandedHome.status));
  const studentHome = await get(asCara, "/dashboard");
  check("a student's home is unchanged", studentHome.status === 200 && !studentHome.body.includes("Nothing to open yet"));
  const rolesPage = await get(asAdmin, "/admin/roles");
  const card = (slug: string) =>
    rolesPage.body
      .split("<a")
      .map((chunk) => chunk.split("</a>")[0])
      .find((chunk) => chunk.includes(`href="/admin/roles/${slug}"`)) ?? "";
  const strandedCard = card(strandedSlug);
  check("roles list marks it 'opens no page'", strandedCard.includes("opens no page"));
  check("roles list shows where it really lands", strandedCard.includes("lands on <!-- -->/dashboard") || strandedCard.includes("lands on /dashboard"));
  const modCard = card(modSlug);
  check("a working custom role isn't flagged", modCard !== "" && !modCard.includes("opens no page"));
  const strandedRole = await get(asAdmin, `/admin/roles/${strandedSlug}`);
  check("role page says it opens no page", strandedRole.body.includes("This role opens no page"));
  const modRole = await get(asAdmin, `/admin/roles/${modSlug}`);
  check("role page lists /admin/teams for a moderator", modRole.body.includes("/admin/teams"));
}

async function cleanup() {
  for (const id of users) {
    await fetch(`${url}/auth/v1/admin/users/${id}`, { method: "DELETE", headers: adm }).catch(() => {});
  }
  if (cohortId) await rest(`cohorts?id=eq.${cohortId}`, { method: "DELETE" }).catch(() => {});
  for (const slug of roles) await rest(`app_roles?slug=eq.${slug}`, { method: "DELETE" }).catch(() => {});
}

try {
  await main();
} catch (err) {
  failures++;
  console.error(err);
} finally {
  await cleanup();
}
console.log(failures === 0 ? "\nAll carryover checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
