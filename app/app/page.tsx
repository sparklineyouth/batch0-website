import { redirect } from "next/navigation";
import { requireViewer, roleHome } from "@/lib/auth";
import { can, canAccessAdmin } from "@/lib/permissions";

/**
 * The manifest's `start_url`, and therefore what the home-screen icon opens.
 *
 * It resolves to nothing itself — it decides which side of the app you belong
 * on and sends you there. That is what lets one installed icon serve staff and
 * students without asking anyone to pick a side at launch.
 *
 * The ordering mirrors `resolveHome` in lib/permissions.ts: admin access wins,
 * because someone who holds it installed this to run the program, not to preview
 * the student view (admins carry the wildcard, so they satisfy both tests). The
 * "Student view" link in /app/admin/more is the deliberate way across, same as
 * the admin sidebar's.
 *
 * Roles with neither side — mentors and investors — have no mobile surface yet,
 * so they go to their real panel rather than a dead end that pretends otherwise.
 * A /mentor mobile side is the obvious next build.
 */
export default async function AppEntry() {
  const { profile, caps } = await requireViewer();
  if (canAccessAdmin(caps)) redirect("/app/admin");
  if (can(caps, "student.dashboard")) redirect("/app/home");
  redirect(await roleHome(profile.role));
}
