import Link from "next/link";
import { ArrowUpRight, ChevronRight, LogOut, User } from "lucide-react";
import { requireViewer } from "@/lib/auth";
import { can, canAccessAdmin } from "@/lib/permissions";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  ADMIN_NAV_GROUPS,
  filterAdminNavItem,
  type NavItem,
} from "@/lib/nav-config";
import { InstallHint } from "@/components/app/install-hint";
import { AppHeader, AppBody, Section, Row, Alert } from "@/components/app/frame";
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
 *
 * Two things about that list are deliberate, because it is 35 links to pages
 * built for a wide screen and it used to be the tallest thing on the screen:
 *
 *   It keeps the sidebar's groups. The first pass flattened them, which handed
 *   a phone one undifferentiated ~2170px card where Operations' 18 rows ran
 *   unbroken from "Pulse" to "Settings". Labels are the only thing that makes a
 *   list this long scannable with a thumb, and the biggest group collapses.
 *
 *   The links open in a new tab (`external`) rather than navigating this window.
 *   /admin resolves on the app host too, so a plain <Link> replaced the whole
 *   installed app with a desktop page and left no tab bar to come back from —
 *   a one-way door out of a standalone PWA. A new tab makes it a detour.
 *
 * Everything a hand reaches for repeatedly — sign out above all, since this is
 * the only sign-out in the admin app — sits ABOVE that list, ordered by how
 * often it is used rather than by how important the topic is.
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

  // No `|| "Overview"` fallback on the label: the one unlabelled group holds
  // exactly /admin, which the item filter drops, so it never survives the
  // `length` check below and can never render a headless Section.
  const groups = ADMIN_NAV_GROUPS.map((g) => ({
    label: g.label,
    items: g.items.filter(
      (item) => item.href !== "/admin" && filterAdminNavItem(item, caps),
    ),
  })).filter((g) => g.items.length > 0);

  return (
    <>
      <AppHeader
        title="More"
        eyebrow={profile.full_name ?? profile.email}
        action={
          // h-11 w-11 explicitly, even though AppHeader's action wrapper sets
          // min-h-11/min-w-11 on its child. The wrapper's rule is a utility
          // (`.[&>*]:min-h-11 > *`, specificity 0-1-0) and globals.css carries
          // an unlayered `@media (pointer: coarse) { a.press { min-height:
          // 36px } }` at 0-1-1 — which wins, so a padding-less <a> in that slot
          // comes out 36px tall on the only devices that matter here. `height`
          // is a different property than `min-height`, so it is not in that
          // fight and actually lands the 44px floor.
          <Link
            href="/app/home"
            prefetch={false}
            aria-label="Switch to the student view"
            className="press h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-line text-ink-soft active:bg-wash"
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

        {/* A real POST form, matching every other sign-out in the app. The
            route rejects cross-origin posts, so a link would not do. */}
        <form action="/auth/signout" method="post" className="mt-9">
          <button
            type="submit"
            className="press inline-flex h-11 w-full items-center justify-center gap-2 rounded-md border border-line bg-wash text-[14px] font-medium text-ink-soft active:scale-[0.99]"
          >
            <LogOut className="h-4 w-4" />
            Sign out
          </button>
        </form>

        <div className="mt-4">
          <InstallHint />
        </div>

        {/* Guarded on `groups`: a viewer whose permissions filter every item
            out would otherwise get a heading and a warning about a list that
            isn't there. */}
        {groups.length > 0 && (
          <Section title="Everything else">
            <Alert tone="info" title="The rest of the admin panel">
              These pages are laid out for a wide screen — readable on a phone,
              but not comfortable. They open in a new tab, so this screen stays
              where you left it.
            </Alert>
          </Section>
        )}

        {groups.map((g) => (
          <Section key={g.label} title={g.label}>
            {g.items.length > COLLAPSE_OVER ? (
              // Operations is the only group this catches: 18 rows is ~1100px
              // of scroll that everyone pays to reach the four groups after it.
              // Native <details> collapses it for no JS — matching the course
              // screen's cards, chevron rotation included.
              <details className="group overflow-hidden rounded-2xl border border-line bg-wash open:bg-paper">
                <summary className="press flex min-h-[3.875rem] cursor-pointer list-none items-center gap-3.5 px-4 py-3.5 active:bg-wash [&::-webkit-details-marker]:hidden sm:px-5">
                  <span className="min-w-0 flex-1 text-[15.5px] leading-snug text-ink-soft">
                    Show all {g.items.length}
                  </span>
                  <ChevronRight className="h-4 w-4 shrink-0 text-ink-faint transition-transform group-open:rotate-90" />
                </summary>
                <div className="border-t border-line px-4 sm:px-5">
                  {navRows(g.items)}
                </div>
              </details>
            ) : (
              <div className="rounded-2xl border border-line px-4 sm:px-5">
                {navRows(g.items)}
              </div>
            )}
          </Section>
        ))}

        <p className="mt-10 text-center font-mono text-[10px] uppercase tracking-[0.22em] text-ink-faint">
          batch<span className="text-phosphor-ink">0</span>
          {canAccessAdmin(caps) ? " · admin" : ""}
        </p>
      </AppBody>
    </>
  );
}

/** Groups above this collapse behind a summary row. Tuned so only Operations
 *  (18) does — the others are 2 to 6 items and cost nothing left open. */
const COLLAPSE_OVER = 8;

function navRows(items: NavItem[]) {
  return items.map((item) => (
    <Row
      key={item.href}
      label={item.label}
      href={item.href}
      // See the note at the top of the file: these leave the app, so they leave
      // it in a new tab. `external` also sidesteps the prefetch question —
      // there is no <Link> to prefetch 35 dynamic admin routes from.
      external
      right={<ArrowUpRight className="h-4 w-4 shrink-0 text-ink-faint" />}
    />
  ));
}
