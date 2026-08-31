import Link from "next/link";
import { ArrowUpRight, LogOut, ShieldCheck } from "lucide-react";
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
    href: "/dashboard/team",
    label: "Your team",
    hint: "Members, offers, cap table",
    external: true,
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
  {
    href: "/dashboard/billing",
    label: "Billing",
    hint: "Receipts and payment method",
    external: true,
  },
  {
    href: "/dashboard/referrals",
    label: "Refer a friend",
    external: true,
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
              className="press shrink-0 rounded-lg border border-line px-2.5 py-2 text-ink-soft active:bg-wash"
            >
              <ShieldCheck className="h-4 w-4" />
            </Link>
          ) : undefined
        }
      />
      <AppBody>
        {team && (
          <Section title="Team">
            <Link
              href="/dashboard/team"
              prefetch={false}
              className="press block rounded-2xl border border-line bg-wash px-5 py-4 active:scale-[0.99]"
            >
              <p className="text-[15px] leading-tight text-ink">{team.name}</p>
              {team.tagline && (
                <p className="mt-1.5 text-[13px] leading-snug text-ink-soft">
                  {team.tagline}
                </p>
              )}
              <p className="mt-2 font-mono text-[11px] uppercase tracking-[0.18em] text-ink-faint">
                {team.memberCount} member{team.memberCount === 1 ? "" : "s"}
              </p>
            </Link>
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
          <p className="mt-2.5 text-[11px] leading-relaxed text-ink-faint">
            <ArrowUpRight className="mb-0.5 inline h-3 w-3" /> opens the full
            dashboard — everything the app doesn&apos;t carry lives there.
          </p>
        </Section>

        <div className="mt-7">
          <InstallHint />
        </div>

        {/* A real POST form, matching every other sign-out in the app. The
            route rejects cross-origin posts, so a link or a fetch would not do. */}
        <form action="/auth/signout" method="post" className="mt-7">
          <button
            type="submit"
            className="press inline-flex h-11 w-full items-center justify-center gap-2 rounded-md border border-line bg-wash text-[14px] font-medium text-ink-soft active:scale-[0.99] active:bg-wash"
          >
            <LogOut className="h-4 w-4" />
            Sign out
          </button>
        </form>

        <p className="mt-6 text-center font-mono text-[10px] uppercase tracking-[0.22em] text-ink-faint">
          batch<span className="text-phosphor-ink">0</span>
        </p>
      </AppBody>
    </>
  );
}

/**
 * The viewer's team, if they're on one. Two queries rather than an embed
 * because `team_members` is joined to itself here — once to find which team the
 * viewer is on, once to count everyone on it.
 */
async function loadTeam(userId: string): Promise<{
  name: string;
  tagline: string | null;
  memberCount: number;
} | null> {
  const admin = createAdminClient();
  const { data: membership } = await admin
    .from("team_members")
    .select("team_id, team:teams(name, tagline)")
    .eq("user_id", userId)
    .limit(1)
    .maybeSingle();
  if (!membership?.team_id) return null;
  const team = (
    Array.isArray(membership.team) ? membership.team[0] : membership.team
  ) as { name: string; tagline: string | null } | null;
  if (!team) return null;
  const { count } = await admin
    .from("team_members")
    .select("id", { count: "exact", head: true })
    .eq("team_id", membership.team_id);
  return { name: team.name, tagline: team.tagline, memberCount: count ?? 0 };
}
