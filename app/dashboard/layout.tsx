import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { getViewer } from "@/lib/auth";
import { isInApp, APP_MARK_COOKIE } from "@/lib/app-host";
import { can } from "@/lib/permissions";
import { getStudentAccess, aiAccessFrom, loadAccessRows } from "@/lib/access";
import { isDiscordEnabled } from "@/lib/discord";
import { StudentSidebar } from "@/components/dashboard/sidebar";
import { MobileNav } from "@/components/mobile-nav";
import { getSiteConfig } from "@/lib/site-config";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // The Discord flag and site config depend on nothing the viewer resolves,
  // so they ride alongside it instead of waiting behind the auth round trip.
  // Both are request-cached, so pages that read them again dedupe.
  // loadAccessRows() rides along even though the access check below needs a
  // role this batch hasn't produced yet: the rows themselves are keyed only on
  // the user, so speculating on them here turns what was a third serial wave
  // into part of this one. getStudentAccess() then reads it back from the
  // request cache. Staff previewing the student view short-circuit before
  // using the rows, so for them this is two parallel reads they didn't
  // strictly need — cheap, and they are not the common case.
  const [viewer, discordEnabled, siteConfig] = await Promise.all([
    getViewer(),
    isDiscordEnabled(),
    getSiteConfig(),
    loadAccessRows(),
  ]);
  if (!viewer) redirect("/login");
  const { profile, caps } = viewer;
  // Theme driven site-wide by next-themes on <html> (see ThemeProvider).

  // Rendering inside the installed app? The app's More screens link out to
  // several /dashboard pages, and the manifest's scope keeps those links in the
  // app window, so without a return path they are one-way trips on a phone with
  // no browser chrome. Same two signals as app/admin/layout.tsx: the subdomain,
  // plus the `b0_app` cookie that lib/supabase/middleware.ts stamps on every
  // /app request for the people who installed from batch0.org/app.
  const inApp =
    isInApp(headers().get("host"), cookies().get(APP_MARK_COOKIE)?.value);

  // Middleware gates /dashboard to roles carrying `student.dashboard` (plus
  // admins, via the wildcard). Anyone else only lands here when middleware
  // sent them to a shared subroute (pay-fine / billing); render those without
  // the student sidebar so the chrome doesn't mislead.
  if (!can(caps, "student.dashboard")) {
    return (
      <div className="min-h-screen bg-paper text-ink">
        {/* This branch has no nav of any kind, which is fine in a browser and a
            dead end in the app window — and it is reachable from there, since
            pay-fine and billing are exactly the pages a mentor or investor gets
            sent to. The contained bar is the only way out. `kind` is inert in
            that mode; it renders one link back to /app. */}
        {inApp && <MobileNav kind="student" inApp />}
        <main id="main-content" tabIndex={-1} className="px-5 py-6 md:px-10 md:py-10">{children}</main>
      </div>
    );
  }

  // Pre-enrollment students see a stripped-down nav (no Team, no Office
  // hours, no Check-in, no Course/Resources). Until they're enrolled
  // those routes either throw "not enrolled" or 404 — hiding the links
  // prevents dead ends in the sidebar. Accepted/enrolled students whose
  // cohort hasn't started yet (preCohort) get the personal pages +
  // Community, plus Kickoff, Resources, and Team once enrolled. Admins
  // always see everything so they can preview the full student view.
  const access = await getStudentAccess(profile.role);
  const enrolled = access.enrolled;
  const preCohort = access.preCohort;
  const aiAccess = aiAccessFrom(access);
  const referralsEnabled = siteConfig.settings.referralsEnabled;

  return (
    <div
      className="flex min-h-screen bg-paper text-ink md:flex-row flex-col"
    >
      <StudentSidebar
        role={profile.role}
        caps={caps}
        aiAccess={aiAccess}
        discordEnabled={discordEnabled}
        enrolled={enrolled}
        referralsEnabled={referralsEnabled}
        preCohort={preCohort}
      />
      <div className="flex flex-1 flex-col">
        <MobileNav
          kind="student"
          role={profile.role}
          caps={caps}
          aiAccess={aiAccess}
          discordEnabled={discordEnabled}
          enrolled={enrolled}
          referralsEnabled={referralsEnabled}
          preCohort={preCohort}
          inApp={inApp}
        />
        <main id="main-content" tabIndex={-1} className="flex-1 px-5 py-6 md:px-10 md:py-10">{children}</main>
      </div>
    </div>
  );
}
