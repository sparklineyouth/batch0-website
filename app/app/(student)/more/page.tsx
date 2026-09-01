import Link from "next/link";
import { ArrowUpRight, ShieldCheck } from "lucide-react";
import { requireViewer } from "@/lib/auth";
import { getStudentAccess } from "@/lib/access";
import { createAdminClient } from "@/lib/supabase/admin";
import { canAccessAdmin } from "@/lib/permissions";
import { isDiscordEnabled } from "@/lib/discord";
import { getSiteConfig } from "@/lib/site-config";
import { PRE_COHORT_ALLOWED_HREFS } from "@/lib/pre-cohort";
import { ENROLLED_ONLY_HREFS } from "@/lib/nav-config";
import { InstallHint } from "@/components/app/install-hint";
import { AppHeader, AppBody, Section, Row } from "@/components/app/frame";
import { SignOut } from "./sign-out";
import type { Role } from "@/lib/types";

export const metadata = { title: "More · batch0" };
export const dynamic = "force-dynamic";

type LinkDef = {
  href: string;
  label: string;
  hint?: string;
  /** True when this leaves the app shell for the full desktop-shaped page. */
  external?: boolean;
  /** The /dashboard route this stands in for, when the href itself is in-app. */
  gate?: string;
};

/**
 * Everything the four tabs deliberately left out.
 *
 * The gating here reuses the same two sources of truth as the sidebar and the
 * middleware — ENROLLED_ONLY_HREFS and PRE_COHORT_ALLOWED_HREFS — rather than
 * re-deciding what a pre-cohort student may see. That matters because the
 * middleware gate is real: a link this page shows but middleware bounces is a
 * dead end that looks like a bug in the app, and the two lists are the only
 * thing keeping the three surfaces agreeing.
 *
 * `external: true` is now a short list on purpose. It used to be seven of the
 * nine entries, which made this screen a menu of desktop exits: two of them
 * (billing, referrals) landed on a horizontally scrolling <table> two taps from
 * a tab bar, and one (team) was a second copy of the card above. What is left
 * are the four pages that genuinely have no phone shape — a one-time kickoff
 * brief, a file library, the Discord handoff, and account settings — and the
 * caption under the list says plainly what tapping one does.
 */
const LINKS: LinkDef[] = [
  {
    href: "/app/announcements",
    label: "Announcements",
    hint: "Everything the team has posted",
    gate: "/dashboard/announcements",
  },
  {
    href: "/app/events",
    label: "Events",
    hint: "Office hours, workshops, demo day",
    gate: "/dashboard/events",
  },
  {
    href: "/dashboard/kickoff",
    label: "Kickoff",
    hint: "Day one details",
    external: true,
  },
  {
    href: "/dashboard/resources",
    label: "Resources",
    hint: "Templates, guides, perks",
    external: true,
  },
  {
    href: "/dashboard/community",
    label: "Discord",
    hint: "The cohort chat",
    external: true,
  },
  // In-app, gated on the /dashboard route they stand in for — same shape as
  // Announcements and Events above. These two used to point straight at
  // /dashboard/billing and /dashboard/referrals, both of which render a
  // fixed-width table that a 390px screen can only scroll sideways through.
  {
    href: "/app/billing",
    label: "Billing",
    hint: "What's due, and what you've paid",
    gate: "/dashboard/billing",
  },
  {
    href: "/app/referrals",
    label: "Refer a friend",
    gate: "/dashboard/referrals",
  },
  {
    href: "/dashboard/settings",
    label: "Settings",
    hint: "Profile, theme, account",
    external: true,
  },
];

export default async function StudentAppMore() {
  const { profile, caps } = await requireViewer();
  const [access, discordEnabled, siteConfig, team] = await Promise.all([
    getStudentAccess(profile.role as Role),
    isDiscordEnabled(),
    getSiteConfig(),
    loadTeam(profile.id),
  ]);

  const visible = LINKS.filter((l) => {
    // The route the gates actually apply to: for in-app screens that stand in
    // for a /dashboard page, that's the page they mirror.
    const gate = l.gate ?? l.href;
    if (gate === "/dashboard/community") return discordEnabled;
    if (gate === "/dashboard/referrals") return siteConfig.settings.referralsEnabled;
    if (gate === "/dashboard/kickoff") return access.enrolled;
    if (!access.enrolled && ENROLLED_ONLY_HREFS.has(gate)) return false;
    if (access.preCohort && !PRE_COHORT_ALLOWED_HREFS.has(gate)) return false;
    return true;
  });

  const build = process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7);

  return (
    <>
      <AppHeader
        title="More"
        eyebrow={profile.full_name ?? profile.email}
        action={
          canAccessAdmin(caps) ? (
            <Link
              href="/app/admin"
              prefetch={false}
              aria-label="Switch to the admin app"
              // A real 44px box, not padding around a 16px icon. This is the
              // staff door into the entire other half of the app, and as
              // `px-2.5 py-2` it was 36x32 — under the floor on both axes, and
              // the coarse-pointer rule in globals.css only ever fixes height.
              className="press inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-line text-ink-soft active:bg-wash"
            >
              <ShieldCheck className="h-4 w-4" />
            </Link>
          ) : undefined
        }
      />
      <AppBody>
        {/* Not a link any more, and the roster is printed rather than counted.
            This card used to be tappable to /dashboard/team, and "Your team"
            in the list below went to the same place — one destination, two
            affordances, both of them exits from the app. The only thing the
            desktop page carried that a phone wants is who is on the team, and
            that fits here: a name, a tagline, and three or four people. Offers
            and the cap table stay on the desktop page, where a document
            actually belongs. */}
        {team && (
          <Section title="Team">
            <div className="rounded-2xl border border-line bg-wash px-5 py-4">
              <p className="text-[15px] leading-tight text-ink">{team.name}</p>
              {team.tagline && (
                <p className="mt-1.5 text-[13px] leading-snug text-ink-soft">
                  {team.tagline}
                </p>
              )}
              <ul className="mt-3.5 space-y-2 border-t border-line pt-3.5">
                {team.members.map((m) => (
                  <li key={m.id} className="flex items-baseline gap-3">
                    <span className="min-w-0 flex-1 truncate text-[13.5px] leading-snug text-ink-soft">
                      {m.name}
                    </span>
                    <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.18em] text-ink-faint">
                      {m.role}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </Section>
        )}

        <Section title="Everything else">
          <div className="rounded-2xl border border-line px-4 sm:px-5">
            {visible.map((l) => (
              <Row
                key={l.href}
                label={l.label}
                value={l.hint}
                href={l.href}
                right={
                  l.external ? (
                    <ArrowUpRight className="h-4 w-4 shrink-0 text-ink-faint" />
                  ) : undefined
                }
              />
            ))}
          </div>
          {/* Says what the arrow actually does. The old wording promised the
              dashboard "opens", which reads as a new window — these are
              same-window client navigations, and passing `external` to make
              that true would not help: an in-scope URL in a standalone PWA
              opens in the app window whatever the target is. So describe the
              real behaviour instead: you leave the app shell, and Back is how
              you return. */}
          <p className="mt-2.5 text-[11px] leading-relaxed text-ink-faint">
            <ArrowUpRight className="mb-0.5 inline h-3 w-3" /> leaves the app for
            the full site, in this same window. Back brings you here.
          </p>
        </Section>

        <div className="mt-7">
          <InstallHint />
        </div>

        {/* Still a real POST form — the route rejects cross-origin posts, so a
            link or a fetch would not do — but now behind a second tap. See
            ./sign-out.tsx for why an accidental sign-out costs so much more
            inside an installed app than it does on the web. */}
        <SignOut />

        <p className="mt-6 text-center font-mono text-[10px] uppercase tracking-[0.22em] text-ink-faint">
          batch<span className="text-phosphor-ink">0</span>
          {/* The build, for support. This surface runs behind a service worker,
              so "reload and try again" is not a reliable way to find out which
              version someone is actually looking at — they have to be able to
              read it off the screen. Free on the server, ships nothing. */}
          {build && <span className="ml-2 normal-case">{build}</span>}
        </p>
      </AppBody>
    </>
  );
}

type TeamMember = { id: string; name: string; role: string };

/**
 * The viewer's team, if they're on one — including who is on it.
 *
 * `team_members` is joined to itself here: once to find which team the viewer
 * is on, and once, through the team, to list everyone on it. That nested embed
 * is what replaced the bare `team_members(count)` aggregate — the card prints
 * the roster now rather than a number, and the names cost the same single round
 * trip the count did.
 *
 * A team is three or four people by construction, so this is not a list that
 * needs a limit; if that ever stops being true the card, not the query, is what
 * has to change.
 */
async function loadTeam(userId: string): Promise<{
  name: string;
  tagline: string | null;
  members: TeamMember[];
} | null> {
  const admin = createAdminClient();
  const { data: membership } = await admin
    .from("team_members")
    .select(
      "team_id, team:teams(name, tagline, team_members(id, role, created_at, profile:profiles(full_name, email)))",
    )
    .eq("user_id", userId)
    .limit(1)
    .maybeSingle();
  if (!membership?.team_id) return null;
  const team = (
    Array.isArray(membership.team) ? membership.team[0] : membership.team
  ) as {
    name: string;
    tagline: string | null;
    team_members?: {
      id: string;
      role: string | null;
      created_at: string | null;
      profile: { full_name: string | null; email: string } | { full_name: string | null; email: string }[] | null;
    }[];
  } | null;
  if (!team) return null;
  return {
    name: team.name,
    tagline: team.tagline,
    members: (team.team_members ?? [])
      // Ordered here rather than in the query: PostgREST cannot order an embed
      // two levels deep, and joined-at is the order the desktop page uses, so
      // the founder who created the team stays at the top on both surfaces.
      .sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? ""))
      .map((m) => {
        const p = Array.isArray(m.profile) ? m.profile[0] : m.profile;
        return {
          id: m.id,
          // Falling back to the email, then to a placeholder: a blank line in a
          // three-person roster reads as a missing teammate.
          name: p?.full_name || p?.email || "Teammate",
          role: m.role ?? "member",
        };
      }),
  };
}
