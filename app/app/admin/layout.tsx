import { redirect } from "next/navigation";
import { requireViewer, roleHome } from "@/lib/auth";
import { can, canAccessAdmin } from "@/lib/permissions";
import { createAdminClient } from "@/lib/supabase/admin";
import { AppShell } from "@/components/app/frame";
import { AppPrefetch } from "@/components/app/prefetch";
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
  // The badge count starts NOW, not after the viewer resolves.
  //
  // It used to sit behind `await requireViewer()`, which made it a second
  // serial cross-region round trip on every single admin screen — and the
  // layout's await is exactly what the loading skeleton waits on. The count is
  // keyed on nothing but "applications that are submitted", so it never needed
  // the viewer at all; only the DECISION to show it does. Speculating costs one
  // count query for a role that turns out not to hold applications.view, which
  // is cheap and, since the number is discarded below before it reaches the
  // client, discloses nothing.
  const pendingPromise = createAdminClient()
    .from("applications")
    .select("id", { count: "exact", head: true })
    .eq("status", "submitted");

  const [viewer, pendingRes] = await Promise.all([
    requireViewer(),
    pendingPromise,
  ]);
  const { profile, caps } = viewer;
  if (!canAccessAdmin(caps)) redirect(await roleHome(profile.role));

  const seeApplications = can(caps, "applications.view");
  const seePeople = can(caps, "people.view");

  // The badge lives in the layout so it reads the same on every screen — a
  // stale "3 pending" on the People tab is worse than no badge at all. Counts
  // exactly what the Review screen queues (`submitted`), so the two agree.
  const pending = seeApplications ? pendingRes.count : null;

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

  return (
    <AppShell tabs={tabs}>
      {children}
      {/* Only the tabs this role can actually open — prefetching a route the
          layout would bounce is a wasted render and a wasted request. */}
      <AppPrefetch routes={tabs.map((t) => t.href)} />
    </AppShell>
  );
}
