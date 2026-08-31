import { redirect } from "next/navigation";
import { requireViewer, roleHome } from "@/lib/auth";
import { can, canAccessAdmin } from "@/lib/permissions";
import { createAdminClient } from "@/lib/supabase/admin";
import { AppShell } from "@/components/app/frame";
import type { Tab } from "@/components/app/tab-bar";

/**
 * The admin app.
 *
 * The desktop panel has ~60 routes. The question this surface answers is
 * narrower and much more specific: what has piled up, who is waiting on a
 * decision, and can I tell everyone something. Those are the three admin jobs
 * that are genuinely time-sensitive and genuinely doable one-handed — and all
 * three are fully functional here, not read-only summaries that make you open a
 * laptop to finish. Applications get decided, announcements get sent, people
 * get looked up.
 *
 * Everything else — the email builder, roles, Discord config, the blog, cohort
 * setup — stays on the desktop panel and is linked from More. Those are
 * considered, multi-field jobs. Shrinking them to 390px would produce something
 * you *can* use and shouldn't.
 *
 * Tabs are permission-filtered, so a narrow custom role (an intern with
 * `applications.view` and nothing else) gets a two-tab app rather than tabs that
 * bounce. Same `can()` the routes and the desktop sidebar use.
 */
export default async function AdminAppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { profile, caps } = await requireViewer();
  if (!canAccessAdmin(caps)) redirect(await roleHome(profile.role));

  const seeApplications = can(caps, "applications.view");
  const seePeople = can(caps, "people.view");

  // The badge on Review. Fetched in the layout so it is correct on every screen
  // rather than only on the one that happens to count applications — a stale
  // "3 pending" on the People tab is worse than no badge at all.
  const { count: pending } = seeApplications
    ? await createAdminClient()
        .from("applications")
        .select("id", { count: "exact", head: true })
        .eq("status", "submitted")
    : { count: null };

  const tabs: Tab[] = [
    { href: "/app/admin", label: "Today", icon: "LayoutDashboard", exact: true },
    seeApplications && {
      href: "/app/admin/review",
      label: "Review",
      icon: "Inbox" as const,
      badge: pending ?? 0,
    },
    seePeople && {
      href: "/app/admin/people",
      label: "People",
      icon: "Users" as const,
    },
    { href: "/app/admin/more", label: "More", icon: "MoreHorizontal" },
  ].filter(Boolean) as Tab[];

  return <AppShell tabs={tabs}>{children}</AppShell>;
}
