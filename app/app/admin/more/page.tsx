import Link from "next/link";
import { ArrowUpRight, LogOut, User } from "lucide-react";
import { requireViewer } from "@/lib/auth";
import { can, canAccessAdmin } from "@/lib/permissions";
import { createAdminClient } from "@/lib/supabase/admin";
import { ADMIN_NAV_GROUPS, filterAdminNavItem } from "@/lib/nav-config";
import { InstallHint } from "@/components/app/install-hint";
import { AppHeader, AppBody, Section, Row } from "@/components/app/frame";
import { AnnounceForm, type CohortOption } from "./announce-form";

export const metadata = { title: "More · Admin" };
export const dynamic = "force-dynamic";

/**
 * The announcement composer, plus a door to everything this app doesn't carry.
 *
 * The "Everything else" list is generated from ADMIN_NAV_GROUPS through the same
 * `filterAdminNavItem` the desktop sidebar uses, rather than a hand-written list
 * of links. That is what stops this screen from rotting: a new admin page shows
 * up here automatically, and a page a role can't open never appears at all.
 * Those links leave the app shell for the full panel, which is honest — they
 * are desktop pages and this says so.
 */
export default async function AdminAppMore() {
  const { profile, caps } = await requireViewer();
  const canAnnounce = can(caps, "announcements.manage");

  // Only the cohorts worth announcing into. A completed cohort is not an
  // audience, and a phone-sized <select> should not carry three years of them.
  const { data: cohorts } = canAnnounce
    ? await createAdminClient()
        .from("cohorts")
        .select("id, name, status")
        .in("status", ["upcoming", "active"])
        .order("starts_on", { ascending: false })
        .limit(10)
    : { data: null };

  const cohortOptions: CohortOption[] = (cohorts ?? []).map((c) => ({
    id: c.id as string,
    name: c.name as string,
  }));

  const reachable = ADMIN_NAV_GROUPS.flatMap((g) => g.items).filter(
    (item) => item.href !== "/admin" && filterAdminNavItem(item, caps),
  );

  return (
    <>
      <AppHeader
        title="More"
        eyebrow={profile.full_name ?? profile.email}
        action={
          <Link
            href="/app/home"
            prefetch={false}
            aria-label="Switch to the student view"
            className="press shrink-0 rounded-lg border border-line px-2.5 py-2 text-ink-soft active:bg-wash"
          >
            <User className="h-4 w-4" />
          </Link>
        }
      />
      <AppBody>
        {canAnnounce && (
          <Section title="Send an announcement">
            <AnnounceForm cohorts={cohortOptions} />
          </Section>
        )}

        <Section title="Everything else">
          <p className="mb-3 text-[12px] leading-relaxed text-ink-faint">
            The full admin panel. These are desktop-shaped pages — they open
            outside the app.
          </p>
          <div className="rounded-2xl border border-line px-4 sm:px-5">
            {reachable.map((item) => (
              <Row
                key={item.href}
                label={item.label}
                href={item.href}
                right={<ArrowUpRight className="h-4 w-4 shrink-0 text-ink-faint" />}
              />
            ))}
          </div>
        </Section>

        <div className="mt-7">
          <InstallHint />
        </div>

        {/* A real POST form, matching every other sign-out in the app. The
            route rejects cross-origin posts, so a link would not do. */}
        <form action="/auth/signout" method="post" className="mt-7">
          <button
            type="submit"
            className="press inline-flex h-11 w-full items-center justify-center gap-2 rounded-md border border-line bg-wash text-[14px] font-medium text-ink-soft active:scale-[0.99]"
          >
            <LogOut className="h-4 w-4" />
            Sign out
          </button>
        </form>

        <p className="mt-6 text-center font-mono text-[10px] uppercase tracking-[0.22em] text-ink-faint">
          batch<span className="text-phosphor-ink">0</span>
          {canAccessAdmin(caps) ? " · admin" : ""}
        </p>
      </AppBody>
    </>
  );
}
