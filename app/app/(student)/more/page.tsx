import Link from "next/link";
import { ArrowUpRight, LogOut, ShieldCheck } from "lucide-react";
import { requireViewer } from "@/lib/auth";
import { getStudentAccess } from "@/lib/access";
import { createAdminClient } from "@/lib/supabase/admin";
import { canAccessAdmin } from "@/lib/permissions";
import { isDiscordEnabled } from "@/lib/discord";
import { getSiteConfig } from "@/lib/site-config";
import { isStudentHrefVisible } from "@/lib/student-nav";
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
 * Everything the four tabs leave out, gated by the same predicate as the
 * dashboard sidebar (lib/student-nav.ts) so the two never disagree.
 */
const LINKS: LinkDef[] = [
  { href: "/app/announcements", label: "Announcements", gate: "/dashboard/announcements" },
  { href: "/app/events", label: "Events", hint: "Live sessions, Demo Day", gate: "/dashboard/events" },
  { href: "/dashboard/calls", label: "1:1 calls", external: true },
  { href: "/dashboard/team", label: "Your team", hint: "Members, Drive, Demo Day", external: true },
  { href: "/dashboard/kickoff", label: "Kickoff", hint: "Day one details", external: true },
  { href: "/dashboard/resources", label: "Resources", hint: "Templates and guides", external: true },
  { href: "/dashboard/community", label: "Discord", external: true },
  { href: "/dashboard/billing", label: "Billing", hint: "Receipts and payment method", external: true },
  { href: "/dashboard/scholarships", label: "Scholarships", external: true },
  { href: "/dashboard/referrals", label: "Refer a friend", external: true },
  { href: "/dashboard/support", label: "Support", hint: "Refunds, billing, account problems", external: true },
  { href: "/dashboard/settings", label: "Settings", hint: "Profile, theme, account", external: true },
];

export default async function StudentAppMore() {
  const { profile, caps } = await requireViewer();
  const [access, discordEnabled, siteConfig, team] = await Promise.all([
    getStudentAccess(profile.role as Role),
    isDiscordEnabled(),
    getSiteConfig(),
    loadTeam(profile.id),
  ]);

  const ctx = {
    discordEnabled,
    referralsEnabled: siteConfig.settings.referralsEnabled,
    enrolled: access.enrolled,
    preCohort: access.preCohort,
    demoDayTicket: access.demoDayTicket,
  };
  // In-app screens are gated as the /dashboard page they stand in for. The
  // in-app Events screen is cohort-only, so a Demo Day ticket holder gets the
  // dashboard page, where RLS shows them their one event.
  const visible = LINKS.filter((l) => isStudentHrefVisible(l.gate ?? l.href, ctx)).map((l) =>
    l.gate === "/dashboard/events" && !access.enrolled
      ? { ...l, href: "/dashboard/events", external: true }
      : l,
  );

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
    .select("team_id, team:teams(name, tagline, team_members(count))")
    .eq("user_id", userId)
    .limit(1)
    .maybeSingle();
  if (!membership?.team_id) return null;
  const team = (
    Array.isArray(membership.team) ? membership.team[0] : membership.team
  ) as {
    name: string;
    tagline: string | null;
    team_members?: { count: number }[];
  } | null;
  if (!team) return null;
  return {
    name: team.name,
    tagline: team.tagline,
    // The count rides along on the embed above rather than costing a second
    // round trip. PostgREST returns an aggregate embed as [{ count: n }].
    memberCount: team.team_members?.[0]?.count ?? 0,
  };
}
