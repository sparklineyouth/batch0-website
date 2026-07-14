import { redirect } from "next/navigation";
import { getProfile } from "@/lib/auth";
import { canUseAi } from "@/lib/access";
import { isDiscordEnabled } from "@/lib/discord";
import { createAdminClient } from "@/lib/supabase/admin";
import { StudentSidebar } from "@/components/dashboard/sidebar";
import { MobileNav } from "@/components/mobile-nav";
import { getSiteConfig } from "@/lib/site-config";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const profile = await getProfile();
  if (!profile) redirect("/login");
  // Flat-black dark-only; surfaces use the reactive ink/paper tokens.

  // Middleware gates /dashboard to students and admins. Mentors and
  // investors only land here when middleware sent them to a shared
  // subroute (pay-fine / billing); render those without the student
  // sidebar so the chrome doesn't mislead.
  if (profile.role === "mentor" || profile.role === "investor") {
    return (
      <div className="min-h-screen bg-paper text-ink">
        <main className="px-5 py-6 md:px-10 md:py-10">{children}</main>
      </div>
    );
  }

  // Pre-enrollment students see a stripped-down nav (no Team, no Office
  // hours, no Check-in, no Course/Resources). Until they're enrolled
  // those routes either throw "not enrolled" or 404 — hiding the links
  // prevents dead ends in the sidebar. Admins always see everything so
  // they can preview the full student view.
  const admin = createAdminClient();
  const { data: enrollment } = await admin
    .from("enrollments")
    .select("id")
    .eq("user_id", profile.id)
    .limit(1)
    .maybeSingle();
  const enrolled = !!enrollment || profile.role === "admin";

  const [aiAccess, discordEnabled, siteConfig] = await Promise.all([
    canUseAi(profile.role),
    isDiscordEnabled(),
    getSiteConfig(),
  ]);
  const referralsEnabled = siteConfig.settings.referralsEnabled;

  return (
    <div
      className="flex min-h-screen bg-paper text-ink md:flex-row flex-col"
    >
      <StudentSidebar
        role={profile.role}
        aiAccess={aiAccess}
        discordEnabled={discordEnabled}
        enrolled={enrolled}
        referralsEnabled={referralsEnabled}
      />
      <div className="flex flex-1 flex-col">
        <MobileNav
          kind="student"
          role={profile.role}
          aiAccess={aiAccess}
          discordEnabled={discordEnabled}
          enrolled={enrolled}
          referralsEnabled={referralsEnabled}
        />
        <main className="flex-1 px-5 py-6 md:px-10 md:py-10">{children}</main>
      </div>
    </div>
  );
}
