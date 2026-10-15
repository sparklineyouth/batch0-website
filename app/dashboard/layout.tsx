import { redirect } from "next/navigation";
import { getViewer } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { getStudentAccess, loadAccessRows } from "@/lib/access";
import { StudentSidebar } from "@/components/dashboard/sidebar";
import { MobileNav } from "@/components/mobile-nav";
import { getSiteConfig } from "@/lib/site-config";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Site config depends on nothing the viewer resolves, so it rides
  // alongside it instead of waiting behind the auth round trip. It's
  // request-cached, so pages that read it again dedupe.
  // loadAccessRows() rides along even though the access check below needs a
  // role this batch hasn't produced yet: the rows themselves are keyed only on
  // the user, so speculating on them here turns what was a third serial wave
  // into part of this one. getStudentAccess() then reads it back from the
  // request cache. Staff previewing the student view short-circuit before
  // using the rows, so for them this is two parallel reads they didn't
  // strictly need — cheap, and they are not the common case.
  const [viewer, siteConfig] = await Promise.all([
    getViewer(),
    getSiteConfig(),
    loadAccessRows(),
  ]);
  if (!viewer) redirect("/login");
  const { profile, caps } = viewer;
  // Theme driven site-wide by next-themes on <html> (see ThemeProvider).

  // Middleware gates /dashboard to roles carrying `student.dashboard` (plus
  // admins, via the wildcard). Anyone else only lands here on a shared
  // subroute (pay-fine / billing, or a live room — the 1:1 at
  // /dashboard/calls/<id>/live or the webinar at /dashboard/events/<id>/live,
  // hosted or attended by mentors, investors and events staff — see
  // lib/dashboard-gate.ts); render those without the student sidebar so the
  // chrome doesn't mislead.
  if (!can(caps, "student.dashboard")) {
    return (
      <div className="min-h-screen bg-paper text-ink">
        <main id="main-content" tabIndex={-1} className="px-5 pb-24 pt-6 md:px-10 md:pb-24 md:pt-10">{children}</main>
      </div>
    );
  }

  // Who sees which link: lib/student-nav.ts.
  const access = await getStudentAccess(profile.role);
  const enrolled = access.enrolled;
  const preCohort = access.preCohort;
  const referralsEnabled = siteConfig.settings.referralsEnabled;

  return (
    <div
      className="flex min-h-screen bg-paper text-ink md:flex-row flex-col"
    >
      <StudentSidebar
        role={profile.role}
        caps={caps}
        enrolled={enrolled}
        referralsEnabled={referralsEnabled}
        preCohort={preCohort}
        demoDayTicket={access.demoDayTicket}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <MobileNav
          kind="student"
          role={profile.role}
          caps={caps}
          enrolled={enrolled}
          referralsEnabled={referralsEnabled}
          preCohort={preCohort}
          demoDayTicket={access.demoDayTicket}
        />
        <main id="main-content" tabIndex={-1} className="flex-1 px-5 pb-24 pt-6 md:px-10 md:pb-24 md:pt-10">{children}</main>
      </div>
    </div>
  );
}
