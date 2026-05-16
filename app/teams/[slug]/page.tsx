import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

type Props = { params: { slug: string } };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const admin = createAdminClient();
  const { data: team } = await admin
    .from("teams")
    .select("name, tagline, public_blurb, is_public, demo_video_url, logo_url, logo_status")
    .ilike("slug", params.slug)
    .maybeSingle();
  if (!team || !team.is_public) return { title: "Team · SparkLine Youth" };
  const desc =
    team.tagline ??
    team.public_blurb?.slice(0, 160) ??
    "A SparkLine Youth team building in public.";
  return {
    title: `${team.name} · SparkLine Youth`,
    description: desc,
    openGraph: {
      title: team.name,
      description: desc,
      images: team.logo_url && team.logo_status === "approved" ? [team.logo_url] : [],
    },
  };
}

export default async function PublicTeamPage({ params }: Props) {
  const admin = createAdminClient();
  const { data: team } = await admin
    .from("teams")
    .select(
      "id, name, slug, tagline, description, public_blurb, demo_video_url, pitch_video_url, website_url, logo_url, logo_status, is_public, demo_day_recap, raised_cents, post_money_cents, lead_investor, round_kind, cohort:cohorts(name, slug)",
    )
    .ilike("slug", params.slug)
    .maybeSingle();
  if (!team || !team.is_public) notFound();

  const [{ data: members }, { count: backers }] = await Promise.all([
    admin
      .from("team_members")
      .select(
        "role, profile:profiles(full_name, mentor_bio)",
      )
      .eq("team_id", team.id),
    admin
      .from("investor_interests")
      .select("id", { count: "exact", head: true })
      .eq("team_id", team.id)
      .in("level", ["interested", "committed"]),
  ]);

  const cohort = Array.isArray(team.cohort) ? team.cohort[0] : team.cohort;
  const showApprovedLogo =
    team.logo_status === "approved" && team.logo_url;
  const videoUrl =
    (team as any).demo_video_url ?? (team as any).pitch_video_url ?? null;

  return (
    <div className="mx-auto max-w-3xl px-4 py-12">
      <Link
        href="/"
        className="text-sm text-white/55 transition hover:text-white"
      >
        ← SparkLine Youth
      </Link>

      <header className="mt-6 flex items-start gap-5">
        <div className="flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-2xl border border-white/10 bg-zinc-900">
          {showApprovedLogo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={team.logo_url ?? ""}
              alt=""
              className="h-full w-full object-cover"
            />
          ) : (
            <span className="text-3xl font-bold text-spark">
              {team.name.slice(0, 1).toUpperCase()}
            </span>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="text-3xl font-bold tracking-tight md:text-4xl">
            {team.name}
          </h1>
          {team.tagline && (
            <p className="mt-1 text-base text-white/70">{team.tagline}</p>
          )}
          <p className="mt-2 text-xs text-white/45">
            {cohort?.name ? `${cohort.name} · ` : ""}
            Built at SparkLine Youth
          </p>
        </div>
      </header>

      <Card className="mt-8">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-white/55">
          The idea
        </h2>
        <p className="mt-3 whitespace-pre-wrap text-sm text-white/85">
          {team.public_blurb ?? team.description ?? "No description yet."}
        </p>
      </Card>

      {videoUrl && (
        <Card className="mt-6">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-white/55">
            Demo
          </h2>
          <div className="mt-3 overflow-hidden rounded-xl border border-white/10">
            {/* iframe-friendly for YouTube/Loom; otherwise we fall back
                to a plain link so we don't trigger CSP issues. */}
            {/youtube\.com|youtu\.be|loom\.com/.test(videoUrl) ? (
              <div className="relative pb-[56.25%]">
                <iframe
                  src={toEmbedUrl(videoUrl)}
                  className="absolute inset-0 h-full w-full"
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                  allowFullScreen
                  title={`${team.name} demo video`}
                />
              </div>
            ) : (
              <a
                href={videoUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="block p-4 text-sm text-spark hover:underline"
              >
                Watch demo video →
              </a>
            )}
          </div>
        </Card>
      )}

      <Card className="mt-6">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-white/55">
          Founders
        </h2>
        <ul className="mt-3 space-y-3">
          {(members ?? []).map((m: any, i: number) => {
            const p = Array.isArray(m.profile) ? m.profile[0] : m.profile;
            return (
              <li key={i}>
                <p className="text-sm font-medium text-white">
                  {p?.full_name ?? "Founder"}
                </p>
                {p?.mentor_bio && (
                  <p className="mt-0.5 text-xs text-white/60">
                    {p.mentor_bio}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      </Card>

      {(team as any).demo_day_recap && (
        <Card className="mt-6">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-white/55">
            Demo Day recap
          </h2>
          <p className="mt-3 whitespace-pre-wrap text-sm text-white/75">
            {(team as any).demo_day_recap}
          </p>
        </Card>
      )}

      <Card className="mt-6 border-spark/30 bg-spark/[0.04]">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-spark">
          Back this team
        </h2>
        <p className="mt-2 text-sm text-white/80">
          {backers != null && backers > 0
            ? `${backers} investor${backers === 1 ? "" : "s"} already watching.`
            : "Be the first to back them."}{" "}
          Investors get a private profile, scorecards, and a direct line to
          the team through SparkLine Youth.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Link href={`/investor?team=${team.slug}`}>
            <Button>Join as investor →</Button>
          </Link>
          {team.website_url && (
            <a
              href={team.website_url}
              target="_blank"
              rel="noopener noreferrer"
            >
              <Button variant="secondary">Visit their site</Button>
            </a>
          )}
        </div>
      </Card>
    </div>
  );
}

function toEmbedUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.hostname.includes("youtu.be")) {
      return `https://www.youtube.com/embed/${u.pathname.replace(/^\//, "")}`;
    }
    if (u.hostname.includes("youtube.com")) {
      const v = u.searchParams.get("v");
      if (v) return `https://www.youtube.com/embed/${v}`;
    }
    if (u.hostname.includes("loom.com")) {
      // Loom share URL → embed URL by replacing /share/ with /embed/
      return url.replace("/share/", "/embed/");
    }
  } catch {
    // fall through
  }
  return url;
}
