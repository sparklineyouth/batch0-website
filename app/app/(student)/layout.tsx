import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowRight, Lock } from "lucide-react";
import { requireViewer, roleHome } from "@/lib/auth";
import { can } from "@/lib/permissions";
import {
  getStudentAccess,
  installedAppAccessFrom,
  loadAccessRows,
} from "@/lib/access";
import { AppShell, ActionLink } from "@/components/app/frame";
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
  { href: "/app/more", label: "More", icon: "MoreHorizontal" },
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
  const [viewer] = await Promise.all([requireViewer(), loadAccessRows()]);
  const { profile, caps } = viewer;

  // Same gate as /dashboard: the participant area is `student.dashboard`.
  // Admins hold the wildcard and pass, which is what makes the "Student view"
  // link in /app/admin/more work.
  if (!can(caps, "student.dashboard")) {
    redirect(await roleHome(profile.role));
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

  return <AppShell tabs={STUDENT_TABS}>{children}</AppShell>;
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
      <div className="mt-9">
        <ActionLink href="/apply">
          {closed ? "Apply to another cohort" : "Start your application"}
          <ArrowRight className="h-4 w-4" />
        </ActionLink>
      </div>
      <Link
        href="/dashboard"
        prefetch={false}
        className="press mt-4 text-[13px] text-ink-soft underline active:text-ink"
      >
        Go to the full dashboard
      </Link>
      <p className="mt-10 font-mono text-[10px] uppercase tracking-[0.22em] text-ink-faint">
        batch<span className="text-phosphor-ink">0</span>
      </p>
    </div>
  );
}
