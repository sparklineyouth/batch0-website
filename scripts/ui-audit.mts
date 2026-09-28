/**
 * Layout audit: render every page as each kind of account, at phone, tablet
 * and desktop widths, and flag what a person would trip over.
 *
 *   npm run build && npx next start -p 3060   # (or npm run dev)
 *   E2E_BASE_URL=http://localhost:3060 npm run ui-audit -- --out=/tmp/ui-audit
 *   ... --only=/admin/challenges,/messages     # a subset of routes
 *
 * For each page it records:
 *   offscreen  an element pokes out past the left or right edge of the screen
 *              with nothing clipping it (so it's cut off, or scrolls the page
 *              sideways where the page allows that)
 *   covered    a link/button/field whose centre is under a fixed or sticky
 *              element (a launcher, a sticky bar, a header) — checked at the
 *              top, middle and bottom of the page, because that is where a
 *              bottom-right launcher lands on a page's last button
 *   spill      text that runs out of its box (an unbroken URL, a long name)
 *   clipped    text cut off by overflow:hidden with no ellipsis to say so
 *   error      the page failed to render (status >= 500 or an error boundary)
 * and saves a viewport screenshot at the top and bottom of every page.
 *
 * Throwaway accounts (e2e-ui-*@example.invalid) are created for the run and
 * removed at the end, like the other e2e scripts; the pages themselves are
 * only read.
 */

import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const OUT = (process.argv.find((a) => a.startsWith("--out=")) ?? "--out=ui-audit").slice(6);
const ONLY = (process.argv.find((a) => a.startsWith("--only=")) ?? "").slice(7).split(",").filter(Boolean);
const CONCURRENCY = Number((process.argv.find((a) => a.startsWith("--jobs=")) ?? "--jobs=4").slice(7));
mkdirSync(OUT, { recursive: true });

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
const adm = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" };

const stamp = String(process.pid);
const PASSWORD = `e2e-${randomBytes(18).toString("base64url")}`;
type Role = "anon" | "student" | "mentor" | "investor" | "admin";
const createdUsers: string[] = [];

async function reapOrphans() {
  const res = await fetch(`${url}/rest/v1/profiles?select=id,email&email=like.e2e-ui-*@example.invalid`, { headers: adm });
  if (!res.ok) return;
  for (const r of (await res.json()) as { id: string; email: string }[]) {
    if (!/^e2e-ui-[a-z]+-[0-9]+@example\.invalid$/.test(r.email ?? "")) continue;
    await fetch(`${url}/auth/v1/admin/users/${r.id}`, { method: "DELETE", headers: adm }).catch(() => {});
  }
}

async function createUser(role: Exclude<Role, "anon">): Promise<{ id: string; session: any } | null> {
  const email = `e2e-ui-${role}-${stamp}@example.invalid`;
  const res = await fetch(`${url}/auth/v1/admin/users`, {
    method: "POST",
    headers: adm,
    body: JSON.stringify({ email, password: PASSWORD, email_confirm: true }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`createUser ${role}: ${JSON.stringify(body)}`);
  createdUsers.push(body.id);
  const patch = await fetch(`${url}/rest/v1/profiles?id=eq.${body.id}`, {
    method: "PATCH",
    headers: adm,
    // A long name on purpose: names are where lists overflow.
    body: JSON.stringify({ role, full_name: `E2E ${role[0].toUpperCase()}${role.slice(1)} Averylonglastnamethatkeepsgoing` }),
  });
  if (!patch.ok) {
    console.log(`  (no ${role} role here: ${await patch.text()})`);
    return null;
  }
  const tok = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: anonKey, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  return { id: body.id, session: await tok.json() };
}

function cookiesFor(session: any) {
  const value = "base64-" + Buffer.from(JSON.stringify(session), "utf8").toString("base64url");
  const parts =
    value.length <= MAX_CHUNK
      ? [{ name: COOKIE_NAME, value }]
      : Array.from({ length: Math.ceil(value.length / MAX_CHUNK) }, (_, n) => ({
          name: `${COOKIE_NAME}.${n}`,
          value: value.slice(n * MAX_CHUNK, (n + 1) * MAX_CHUNK),
        }));
  return parts.map((c) => ({ ...c, url: BASE, httpOnly: false, secure: false, sameSite: "Lax" as const }));
}

async function firstId(table: string, col = "id", order = "created_at.desc", extra = ""): Promise<string | null> {
  const res = await fetch(`${url}/rest/v1/${table}?select=${col}&order=${order}&limit=1${extra}`, { headers: adm });
  if (!res.ok) return null;
  const rows = await res.json();
  return rows[0]?.[col] ?? null;
}

// --- routes -----------------------------------------------------------------
const PUBLIC = [
  "/", "/apply", "/blog", "/challenges", "/login", "/signup", "/forgot-password", "/parents", "/pass",
  "/pay", "/privacy", "/program", "/refund-policy", "/sample-lesson", "/sponsors", "/start", "/terms",
];
const STUDENT = [
  "/dashboard", "/dashboard/accepted", "/dashboard/ai", "/dashboard/announcements", "/dashboard/application",
  "/dashboard/billing", "/dashboard/calls", "/dashboard/checkin", "/dashboard/community", "/dashboard/course",
  "/dashboard/discussions", "/dashboard/enrolled", "/dashboard/events", "/dashboard/files", "/dashboard/intros",
  "/dashboard/kickoff", "/dashboard/office-hours", "/dashboard/phone", "/dashboard/referrals", "/dashboard/resources",
  "/dashboard/scholarships", "/dashboard/settings", "/dashboard/team", "/messages", "/notifications",
  "/app/home", "/app/events", "/app/course", "/app/checkin", "/app/announcements", "/app/more",
];
const MENTOR = [
  "/mentor", "/mentor/calls", "/mentor/checkins", "/mentor/course", "/mentor/office-hours", "/mentor/resources",
  "/mentor/students", "/mentor/teams", "/messages",
];
const INVESTOR = ["/investor", "/investor/calls", "/investor/demo-day", "/investor/interests", "/investor/intros", "/investor/teams", "/messages"];
const ADMIN = [
  "/admin", "/admin/ai-usage", "/admin/announcements", "/admin/application-questions", "/admin/applications",
  "/admin/audit", "/admin/blog", "/admin/blog/new", "/admin/calls", "/admin/challenges", "/admin/challenges/new",
  "/admin/charges", "/admin/cohorts", "/admin/course", "/admin/course/analytics", "/admin/demo-day",
  "/admin/demo-day/rubric", "/admin/demo-day/tickets", "/admin/discord", "/admin/discussions", "/admin/email",
  "/admin/email/automations", "/admin/email/automations/new", "/admin/email/blast", "/admin/email/compose",
  "/admin/email/outbox", "/admin/email/phone-request", "/admin/email/settings", "/admin/email/templates",
  "/admin/email/templates/new", "/admin/events", "/admin/flows", "/admin/flows/new", "/admin/interventions",
  "/admin/intros", "/admin/mentors", "/admin/mentors/match", "/admin/messages", "/admin/moderation",
  "/admin/pass-requests", "/admin/passes", "/admin/payments", "/admin/payments/acquisition", "/admin/pricing",
  "/admin/progress", "/admin/pulse", "/admin/recovery", "/admin/referrals", "/admin/resources",
  "/admin/resources/new", "/admin/roles", "/admin/roles/new", "/admin/scholarships", "/admin/scholarships/new",
  "/admin/scholarships/applications", "/admin/settings", "/admin/students", "/admin/students/new", "/admin/teams",
  "/admin/teams/new", "/admin/webinars", "/app/admin", "/app/admin/people", "/app/admin/review", "/app/admin/more",
  "/messages", "/notifications",
  "/dev/live", "/dev/live/room", "/dev/live/room?role=viewer",
  "/dev/challenge?view=event&state=signedout", "/dev/challenge?view=event&state=registered",
  "/dev/challenge?view=event&state=winner", "/dev/challenge?view=event&state=closed",
  "/dev/challenge?view=submit&state=draft", "/dev/challenge?view=submit&state=submitted",
  "/dev/challenge?view=editor&state=draft",
];

type Issue = { kind: string; detail: string };
type PageResult = { role: Role; route: string; viewport: string; status: number | null; finalUrl: string; issues: Issue[]; shots: string[] };

// Runs in the page. Plain JS on purpose (it is serialised into the browser).
const DETECT = `((pos) => {
  const vw = window.innerWidth, vh = window.innerHeight;
  const out = [];
  const describe = (el) => {
    if (!el) return "?";
    const cls = (typeof el.className === "string" ? el.className : "").split(/\\s+/).filter(Boolean).slice(0, 6).join(".");
    const label = el.getAttribute && (el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.getAttribute("name"));
    const text = (el.innerText || el.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 50);
    return el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + (cls ? "." + cls : "") + (label ? " [" + label + "]" : text ? ' "' + text + '"' : "");
  };
  // Also anything inside a closed <details> (other than its summary): it
  // isn't rendered, even where the browser still reports a box for it.
  const ignorable = (el) =>
    !el ||
    !!el.closest("nextjs-portal, [data-nextjs-toast], #__next-build-watcher, script, style, noscript, .sr-only") ||
    (!!el.closest("details:not([open])") && !el.closest("summary"));
  const visible = (el) => {
    const s = getComputedStyle(el);
    if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const all = Array.from(document.querySelectorAll("body *")).filter((el) => !ignorable(el));

  // Anything poking out past the screen's edges. Asked of the elements
  // themselves rather than of documentElement.scrollWidth: with overflow-x
  // clipped on html/body (as on this site) the page never scrolls sideways,
  // so that check could never fire — the content is just cut off instead.
  {
    const culprits = [];
    for (const el of all) {
      if (!visible(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.right <= vw + 1 && r.left >= -1) continue;
      let p = el.parentElement, clipped = false;
      while (p && p !== document.body && p !== document.documentElement) {
        const st = getComputedStyle(p);
        if (/hidden|auto|scroll|clip/.test(st.overflowX) || st.position === "fixed") { clipped = true; break; }
        p = p.parentElement;
      }
      if (clipped) continue;
      if (culprits.some((c) => c.el.contains(el))) continue;
      culprits.push({ el, r });
    }
    for (const c of culprits.slice(0, 5)) {
      out.push({ kind: "offscreen", detail: describe(c.el) + " (left " + Math.round(c.r.left) + ", right " + Math.round(c.r.right) + " of " + vw + ")" });
    }
  }

  // Covered controls. What counts depends on where the pinned element sits:
  // content sliding under a sticky header mid-scroll is how sticky headers
  // work, so a TOP bar only counts at the top of the page (covering content
  // at rest), and a BOTTOM bar or launcher only at the end of the page —
  // there the last controls can't be scrolled out from under it, which is
  // the overlap people actually hit.
  const pinned = all.filter((el) => { const p = getComputedStyle(el).position; return (p === "fixed" || p === "sticky") && visible(el); });
  const edge = (el) => {
    const r = el.getBoundingClientRect();
    if (r.top <= 1 && r.height < vh / 2) return "top";
    // Within a thumb's reach of the bottom edge counts as pinned there: a
    // floating launcher sits 20px up, and mid-page it only passes over
    // content the reader can scroll out from under it.
    if (r.bottom >= vh - 48 && r.height < vh / 2) return "bottom";
    return "floating";
  };
  const controls = all.filter((el) => el.matches('a[href], button, input:not([type=hidden]), textarea, select, [role=button], summary') && visible(el));
  for (const c of controls) {
    const r = c.getBoundingClientRect();
    if (r.bottom <= 0 || r.top >= vh || r.right <= 0 || r.left >= vw) continue;
    const pts = [[r.left + r.width / 2, r.top + r.height / 2]];
    for (const [x, y] of pts) {
      if (x < 0 || y < 0 || x >= vw || y >= vh) continue;
      const top = document.elementFromPoint(x, y);
      if (!top || ignorable(top) || c.contains(top) || top.contains(c)) continue;
      const by = pinned.find((p) => p.contains(top));
      if (!by || by.contains(c)) continue;
      const e = edge(by);
      if (e === "top" && pos !== "top") continue;
      if (e === "bottom" && pos !== "bottom") continue;
      out.push({ kind: "covered", detail: describe(c) + "  UNDER  " + describe(by) + " [" + e + "]" });
    }
  }

  // Text that runs out of its box, or is cut off without an ellipsis.
  for (const el of all) {
    if (!visible(el)) continue;
    const hasText = Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim().length > 0);
    if (!hasText) continue;
    const s = getComputedStyle(el);
    const over = el.scrollWidth - el.clientWidth;
    if (over <= 2 || el.clientWidth === 0) continue;
    if (s.display === "inline") continue;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 1 || rect.height <= 1) continue;
    const clips = /hidden|clip/.test(s.overflowX) || /hidden|clip/.test(s.overflow);
    const scrolls = /auto|scroll/.test(s.overflowX);
    if (scrolls) continue;
    if (clips) {
      if (s.textOverflow === "ellipsis" || s.webkitLineClamp !== "none") continue;
      out.push({ kind: "clipped", detail: describe(el) + " (" + over + "px cut)" });
    } else {
      // Only text that runs out past its container's edge (or the screen's)
      // is a visible problem; overflowing a box that sits inside a wider one
      // just uses the space.
      const parent = el.parentElement ? el.parentElement.getBoundingClientRect() : { right: vw };
      const reach = rect.left + el.scrollWidth;
      if (reach > Math.min(parent.right, vw) + 2) {
        out.push({ kind: "spill", detail: describe(el) + " (" + Math.round(reach - Math.min(parent.right, vw)) + "px past its container)" });
      }
    }
  }

  // An error boundary or Next's error page.
  const body = document.body.innerText || "";
  if (/Application error|Something went wrong|This page couldn.t load|Internal Server Error/i.test(body)) {
    out.push({ kind: "error", detail: body.trim().slice(0, 160).replace(/\\s+/g, " ") });
  }
  return out;
})`;

const VIEWPORTS = [
  { name: "phone", width: 375, height: 740 },
  { name: "tablet", width: 768, height: 1000 },
  { name: "laptop", width: 1024, height: 768 },
  { name: "desktop", width: 1280, height: 800 },
];

function slugOf(route: string) {
  return route.replace(/^\//, "").replace(/[/?=&]+/g, "_") || "home";
}

async function auditPage(page: Page, role: Role, route: string, vp: (typeof VIEWPORTS)[number]): Promise<PageResult> {
  const issues: Issue[] = [];
  const shots: string[] = [];
  let status: number | null = null;
  try {
    const res = await page.goto(`${BASE}${route}`, { waitUntil: "domcontentloaded", timeout: 45_000 });
    status = res?.status() ?? null;
    await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {});
    await page.waitForTimeout(400);
  } catch (e) {
    issues.push({ kind: "error", detail: `navigation: ${(e as Error).message.slice(0, 120)}` });
    return { role, route, viewport: vp.name, status, finalUrl: page.url(), issues, shots };
  }
  if (status && status >= 500) issues.push({ kind: "error", detail: `HTTP ${status}` });

  const seen = new Set<string>();
  const base = `${OUT}/${role}/${vp.name}`;
  mkdirSync(base, { recursive: true });
  const positions = ["top", "middle", "bottom"] as const;
  for (const pos of positions) {
    await page.evaluate((p) => {
      const h = document.documentElement.scrollHeight - window.innerHeight;
      window.scrollTo(0, p === "top" ? 0 : p === "middle" ? Math.max(0, h / 2) : Math.max(0, h));
    }, pos);
    // Long enough for a scroll-driven bar to finish its show/hide transition.
    await page.waitForTimeout(450);
    const found = (await page.evaluate(`(${DETECT})(${JSON.stringify(pos)})`).catch(() => [])) as Issue[];
    for (const i of found) {
      const key = `${i.kind}|${i.detail}`;
      if (seen.has(key)) continue;
      seen.add(key);
      issues.push({ ...i, detail: pos === "top" ? i.detail : `${i.detail}  (scrolled to ${pos})` });
    }
    if (pos !== "middle") {
      const file = `${base}/${slugOf(route)}__${pos}.png`;
      await page.screenshot({ path: file }).catch(() => {});
      shots.push(file);
    }
  }
  return { role, route, viewport: vp.name, status, finalUrl: page.url().replace(BASE, ""), issues, shots };
}

async function main() {
  console.log(`ui-audit against ${BASE} → ${OUT}`);
  await reapOrphans();
  const results: PageResult[] = [];
  let browser: Browser | null = null;
  const conversationIds: string[] = [];
  try {
    const users: Partial<Record<Role, { id: string; session: any } | null>> = {};
    for (const r of ["student", "mentor", "investor", "admin"] as const) users[r] = await createUser(r);

    // Real ids for the dynamic routes worth seeing.
    const challengeSlug = await firstId("challenges", "slug");
    const challengeId = await firstId("challenges");
    const eventId = await firstId("events", "id", "starts_at.desc");
    const extraAdmin: string[] = [];
    const extraStudent: string[] = [];
    const extraPublic: string[] = [];
    if (challengeSlug) {
      extraPublic.push(`/challenges/${challengeSlug}`);
      extraStudent.push(`/challenges/${challengeSlug}`, `/challenges/${challengeSlug}/submit`);
    }
    if (challengeId) {
      extraAdmin.push(`/admin/challenges/${challengeId}/edit`, `/admin/challenges/${challengeId}/registrations`, `/admin/challenges/${challengeId}/submissions`);
      const sub = await firstId("challenge_submissions", "id", "created_at.desc", `&challenge_id=eq.${challengeId}`);
      if (sub) extraAdmin.push(`/admin/challenges/${challengeId}/submissions/${sub}`);
    }
    if (eventId) {
      extraAdmin.push(`/admin/events/${eventId}`);
      extraStudent.push(`/dashboard/events/${eventId}`);
    }
    for (const [route, table, col] of [
      ["/admin/applications/", "applications", "id"],
      ["/admin/students/", "profiles", "id"],
      ["/admin/teams/", "teams", "id"],
      ["/admin/blog/", "blog_posts", "id"],
      ["/admin/resources/", "resources", "id"],
      ["/admin/email/templates/", "email_templates", "id"],
      ["/admin/scholarships/", "scholarships", "id"],
      ["/admin/discussions/", "discussions", "id"],
    ] as const) {
      const id = await firstId(table, col);
      if (id) extraAdmin.push(`${route}${id}`);
    }
    const cohort = await firstId("cohorts");
    if (cohort) extraAdmin.push(`/admin/cohorts/${cohort}/health`, `/admin/cohorts/${cohort}/kickoff`);

    // A conversation with the content that breaks layouts: a long message, an
    // unbroken URL, and a long name. Only if the DM tables exist.
    if (users.student && users.mentor) {
      const [a, b] = [users.student.id, users.mentor.id].sort();
      const res = await fetch(`${url}/rest/v1/dm_conversations`, {
        method: "POST",
        headers: { ...adm, Prefer: "return=representation" },
        body: JSON.stringify({ user_a: a, user_b: b }),
      });
      if (res.ok) {
        const [c] = await res.json();
        conversationIds.push(c.id);
        const bodies = [
          "Hey! Quick question about the challenge.",
          "Here is my repo https://github.com/someone/an-extremely-long-repository-name-that-never-breaks/blob/main/src/components/very/deep/path/file.tsx",
          "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(12),
          "Averylongwordwithoutanyspacesthatshouldwrapinsidethebubbleandnotpushthelayoutsideways",
        ];
        for (const [i, body] of bodies.entries()) {
          await fetch(`${url}/rest/v1/dm_messages`, {
            method: "POST",
            headers: adm,
            body: JSON.stringify({ conversation_id: c.id, sender_id: i % 2 ? users.mentor.id : users.student.id, body }),
          });
        }
        for (const r of ["student", "mentor"] as const) {
          (r === "student" ? extraStudent : MENTOR).push(`/messages?c=${c.id}`);
        }
      } else {
        console.log("  (no dm tables yet — skipping the conversation fixture)");
      }
    }

    const plan: { role: Role; route: string }[] = [
      ...[...PUBLIC, ...extraPublic].map((route) => ({ role: "anon" as Role, route })),
      ...[...STUDENT, ...extraStudent].map((route) => ({ role: "student" as Role, route })),
      ...MENTOR.map((route) => ({ role: "mentor" as Role, route })),
      ...INVESTOR.map((route) => ({ role: "investor" as Role, route })),
      ...[...ADMIN, ...extraAdmin].map((route) => ({ role: "admin" as Role, route })),
    ].filter((p) => (p.role === "anon" || users[p.role]) && (!ONLY.length || ONLY.some((o) => p.route.startsWith(o))));

    browser = await chromium.launch({ headless: true });
    const jobs = plan.flatMap((p) => VIEWPORTS.map((vp) => ({ ...p, vp })));
    console.log(`  ${jobs.length} page renders (${plan.length} routes × ${VIEWPORTS.length} widths)`);
    let next = 0;
    const worker = async () => {
      while (next < jobs.length) {
        const job = jobs[next++];
        const ctx = await browser!.newContext({ viewport: { width: job.vp.width, height: job.vp.height }, deviceScaleFactor: 1 });
        if (job.role !== "anon") await ctx.addCookies(cookiesFor(users[job.role]!.session));
        const page = await ctx.newPage();
        const r = await auditPage(page, job.role, job.route, job.vp);
        results.push(r);
        const n = r.issues.length;
        console.log(`  ${n ? "!!" : "ok"}  ${job.role.padEnd(8)} ${job.vp.name.padEnd(7)} ${job.route}${r.finalUrl !== job.route ? ` → ${r.finalUrl}` : ""}${n ? `  (${n})` : ""}`);
        await ctx.close();
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  } finally {
    await browser?.close().catch(() => {});
    for (const id of createdUsers) await fetch(`${url}/auth/v1/admin/users/${id}`, { method: "DELETE", headers: adm }).catch(() => {});
    results.sort((a, b) => (a.role + a.route + a.viewport).localeCompare(b.role + b.route + b.viewport));
    writeFileSync(`${OUT}/report.json`, JSON.stringify(results, null, 2));
    const flagged = results.filter((r) => r.issues.length);
    console.log(`\n${flagged.length}/${results.length} renders flagged; report at ${OUT}/report.json`);
  }
}

void main();
