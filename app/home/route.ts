import { redirect } from "next/navigation";
import { getProfile, roleHome } from "@/lib/auth";

// This handler reads cookies, so it can never be cached. That is the whole
// point: it concentrates the marketing site's one auth-dependent decision
// into a single dynamic URL, which lets every page that links to it be
// prerendered.
export const dynamic = "force-dynamic";

/**
 * "Take me where I belong."
 *
 * The marketing navbar and hero used to resolve this server-side on every
 * page — `getProfile()` then `roleHome()` — purely to decide one href. Because
 * `getProfile()` reads cookies, that single decision forced six marketing
 * routes (including all 135 blog posts) to render per-request instead of
 * being served as static HTML from the CDN.
 *
 * So the CTAs now point at this constant path and the redirect happens here,
 * at click time, for the one visitor in a hundred who is actually signed in.
 * Role resolution stays on the server where `profiles.role` and
 * `app_roles.permissions` live — neither is in the JWT, so a client-side
 * version of this would need its own round trip anyway.
 */
export async function GET() {
  const profile = await getProfile();
  redirect(profile ? await roleHome(profile.role) : "/apply");
}
