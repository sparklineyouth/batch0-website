import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { ArrowRight, Lock } from "lucide-react";
import { requireViewer, roleHome } from "@/lib/auth";
import { can } from "@/lib/permissions";
import {
  getStudentAccess,
  installedAppAccessFrom,
  loadAccessRows,
  hasPendingFine,
} from "@/lib/access";
import { AppShell, ActionLink } from "@/components/app/frame";
import { AppPrefetch } from "@/components/app/prefetch";
import type { Tab } from "@/components/app/tab-bar";
import type { Role } from "@/lib/types";

/**
 * The four things a student does from a phone.
 *
 * Getting to four was the whole design problem. The student sidebar carries 17
 * links; most are things you do once (billing, referrals, settings) or things
 * that want a keyboard and a big screen (the AI co-founder, file uploads, the
 * pitch coach). What is left — where am I, what's this week, log my week, and a
 * door to everything else — is what a phone is actually good for.
 *
 * Announcements and Events are deliberately NOT tabs even though they are read
 * often. They are read, not acted on, so they surface on Home where you already
 * are, and live as full screens under More. A fifth tab would have cost every
 * screen ~20% of the tab bar's width to save one tap on a page nobody opens
 * twice a day.
 */
const STUDENT_TABS: Tab[] = [
  { href: "/app/home", label: "Home", icon: "Home", exact: true },
  { href: "/app/course", label: "Course", icon: "PlayCircle" },
  { href: "/app/checkin", label: "Check in", icon: "CheckCircle" },
  // Announcements and Events are reached through More but do not live under
  // it, so More adopts them — otherwise all four tabs read as inactive on two
  // screens a student opens every week, and the bar says "you are nowhere".
  {
    href: "/app/more",
    label: "More",
    icon: "MoreHorizontal",
    match: ["/app/announcements", "/app/events", "/app/billing", "/app/referrals"],
  },
];

// Every tab plus the two full screens that hang off More. Defined at module
// scope so its identity is stable and the prefetcher does not re-run on every
// render of the layout.
//
// /app/notifications is deliberately not here. This list is the set of screens
// a student reaches by tapping the chrome that is on every page, so warming
// them pays off on the very next tap. Notifications hangs off the Home header
// instead — one entry point, opened when something is unread — so it carries a
// back affordance of its own rather than a speculative fetch on every screen.
const PREFETCH_ROUTES = [
  "/app/home",
  "/app/course",
  "/app/checkin",
  "/app/more",
  "/app/announcements",
  "/app/events",
];

export default async function StudentAppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Two reads, one wave. The eligibility check below needs a role this batch
  // hasn't produced yet, but loadAccessRows() is keyed only on the signed-in
  // user — so speculating on it here collapses what was a second serial
  // cross-region round trip into this one. getStudentAccess() then reads it
  // back from the request cache, and so does the page that renders next.
  //
  // This matters more here than on /dashboard: the layout's await is what the
  // loading boundary waits on, so every round trip spent here is time the
  // skeleton stays on screen. Same pattern as app/dashboard/layout.tsx.
  const [viewer, , pendingFine] = await Promise.all([
    requireViewer(),
    loadAccessRows(),
    hasPendingFine(),
  ]);
  const { profile, caps } = viewer;

  // Same gate as /dashboard: the participant area is `student.dashboard`.
  // Admins hold the wildcard and pass, which is what makes the "Student view"
  // link in /app/admin/more work.
  if (!can(caps, "student.dashboard")) {
    redirect(await roleHome(profile.role));
  }

  // The pending-fine hard block, which used to live in middleware for /app.
  //
  // Moving it here is what let middleware stop doing database work on /app
  // entirely: at the edge this check cost a cross-region round trip before the
  // page could start, on every single tab tap. Here it rides in the batch
  // above and costs nothing measurable — same rule, same destination, a
  // fraction of the latency.
  //
  // Full admins bypass, matching middleware, so they can still reach /admin to
  // waive the fine they are looking at.
  //
  // The destination is /app/billing, not /dashboard/pay-fine. A fine is the one
  // state where the app has something genuinely urgent to say, and it was the
  // one state that ejected the student out of the installed app onto a desktop
  // route to say it — a standalone window with no back button, for the message
  // that most needs to be acted on. /app/billing shows the same fine in a warn
  // Alert, with the same ChargePayButton, inside the app shell.
  //
  // Billing has to be exempt from the gate or the redirect is an infinite loop:
  // it lives in this route group, so this layout runs for it too. `x-pathname`
  // is stamped by the middleware, which is also where the admin layout gets it.
  // The exemption is exactly one path — every other screen stays blocked, so
  // the lock still does its job.
  const path = headers().get("x-pathname") ?? "";
  if (pendingFine && !caps.superAdmin && path !== "/app/billing") {
    redirect("/app/billing");
  }

  // The app is for people who are actually in the program — enrolled, or with a
  // live application. Enforced here rather than in middleware because the
  // answer needs the enrollments and applications rows, and getStudentAccess
  // already has them request-cached for the page that renders next: gating here
  // costs nothing, gating in middleware would cost two cross-region reads on
  // every request.
  //
  // Rendered as a screen, not a redirect. Everyone reaching this point is
  // signed in and holds `student.dashboard`, so their role home IS /dashboard —
  // bouncing them there would be a silent round trip that looks like the app
  // failing to open, and bouncing to /app would loop.
  const access = await getStudentAccess(profile.role as Role);
  if (!installedAppAccessFrom(access)) {
    return <NotInTheProgram status={access.applicationStatus} />;
  }

  return (
    <AppShell tabs={STUDENT_TABS}>
      {children}
      {/* Warms the other three tabs so tapping one is instant. See the
          component for why this is imperative rather than left to <Link>. */}
      <AppPrefetch routes={PREFETCH_ROUTES} />
    </AppShell>
  );
}

/**
 * The locked screen, with the one action that actually moves the person
 * forward. No tab bar: there is nothing behind it for them yet, and four dead
 * tabs would read as a broken app rather than a closed door.
 */
function NotInTheProgram({ status }: { status: string | null }) {
  const closed = status === "rejected" || status === "withdrawn";
  return (
    <div className="flex min-h-[100dvh] flex-col items-center justify-center bg-paper px-8 pt-[var(--safe-top)] text-center text-ink">
      <Lock className="h-7 w-7 text-ink-faint" />
      <h1 className="mt-6 font-display text-3xl leading-none tracking-[-0.01em]">
        {closed ? "Not this cohort" : "The app opens when you apply"}
      </h1>
      <p className="mt-4 max-w-xs text-[14px] leading-relaxed text-ink-soft">
        {closed
          ? "Your application for this cohort is closed, so there's nothing here to show you yet. You can apply again when the next one opens."
          : "batch0 on your phone is for students in the program. Submit an application and it unlocks — you'll get your cohort, your week, and your check-in right here."}
      </p>
      {/* One action, and only one. This used to also carry a "Go to the full
          dashboard" link — a same-window navigation out of the standalone
          window into a desktop-shaped surface that has nothing for someone who
          is not in the program (that absence is why this screen exists), and
          nothing over there links back. Applying is the only thing that moves
          this person forward. */}
      <div className="mt-9">
        <ActionLink href="/apply">
          {closed ? "Apply to another cohort" : "Start your application"}
          <ArrowRight className="h-4 w-4" />
        </ActionLink>
      </div>
      {/* The way off this screen that isn't "apply". There is no tab bar here
          and no dashboard link any more, so without this the only affordance a
          locked-out person has is the one action they may have already decided
          against — and someone who signed in with the wrong account, or handed
          the phone to a sibling, has no way to get back to a sign-in form.
          A plain POST form rather than the two-step control on More: a stray
          tap on a screen with nothing behind it costs nothing, and this must
          keep working before JavaScript has hydrated. */}
      <form action="/auth/signout" method="post" className="mt-4">
        <button
          type="submit"
          className="press inline-flex h-11 items-center px-3 text-[13px] text-ink-soft underline active:text-ink"
        >
          Sign out
        </button>
      </form>
      <p className="mt-6 font-mono text-[10px] uppercase tracking-[0.22em] text-ink-faint">
        batch<span className="text-phosphor-ink">0</span>
      </p>
    </div>
  );
}
