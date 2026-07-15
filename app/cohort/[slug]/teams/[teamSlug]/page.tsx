import Link from "next/link";
import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { passHolderUserIds } from "@/lib/founder-pass";
import Navbar from "@/components/navbar";
import Footer from "@/components/footer";
import { FounderPassBadge } from "@/components/founder-pass-badge";
import { ExternalLink } from "lucide-react";

export async function generateMetadata({
  params,
}: {
  params: { slug: string; teamSlug: string };
}) {
  const admin = createAdminClient();
  const { data } = await admin
    .from("teams")
    .select("name, tagline, cohort:cohorts!inner(slug)")
    .eq("slug", params.teamSlug)
    .eq("is_public", true)
    .maybeSingle();
  return {
    title: data ? `${data.name} · batch0` : "Team",
    description: (data as any)?.tagline ?? undefined,
  };
}

export default async function TeamProfile({
  params,
}: {
  params: { slug: string; teamSlug: string };
}) {
  const admin = createAdminClient();
  const { data: cohort } = await admin
    .from("cohorts")
    .select("id, name, slug")
    .eq("slug", params.slug)
    .maybeSingle();
  if (!cohort) notFound();

  const { data: team } = await admin
    .from("teams")
    .select("*")
    .eq("cohort_id", cohort.id)
    .eq("slug", params.teamSlug)
    .eq("is_public", true)
    .maybeSingle();
  if (!team) notFound();

  const [{ data: members }, passHolders] = await Promise.all([
    admin
      .from("team_members")
      .select("role, user_id, user:profiles(full_name)")
      .eq("team_id", team.id),
    passHolderUserIds(admin),
  ]);

  return (
    <main className="relative min-h-screen overflow-hidden bg-black text-white">
      <Navbar />
      <article className="relative mx-auto max-w-3xl px-6 pt-32 pb-20">
        <Link
          href={`/cohort/${cohort.slug}`}
          className="text-sm text-white/55 hover:text-white"
        >
          ← Back to {cohort.name}
        </Link>

        <div className="mt-6 flex items-start gap-5">
          {team.logo_url ? (
            <img
              src={team.logo_url}
              alt={`${team.name} logo`}
              className="h-16 w-16 rounded-2xl object-cover"
            />
          ) : (
            <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-phosphor/15 text-2xl font-bold text-phosphor">
              {team.name.charAt(0)}
            </div>
          )}
          <div>
            <h1 className="text-4xl font-bold tracking-tight">{team.name}</h1>
            {team.tagline && (
              <p className="mt-1 text-lg text-white/65">{team.tagline}</p>
            )}
          </div>
        </div>

        {team.description && (
          <p className="mt-8 whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-base leading-relaxed text-white/80">
            {team.description}
          </p>
        )}

        {(team.pitch_video_url ||
          team.pitch_deck_url ||
          team.website_url) && (
          <div className="mt-8 flex flex-wrap gap-3">
            {team.website_url && (
              <a
                href={team.website_url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 rounded-full bg-phosphor px-4 py-2 text-sm font-semibold text-on-phosphor hover:bg-phosphor-200"
              >
                Visit website <ExternalLink className="h-3.5 w-3.5" />
              </a>
            )}
            {team.pitch_deck_url && (
              <a
                href={team.pitch_deck_url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-white/5 px-4 py-2 text-sm font-medium text-white hover:bg-white/10"
              >
                Pitch deck <ExternalLink className="h-3.5 w-3.5" />
              </a>
            )}
            {team.pitch_video_url && (
              <a
                href={team.pitch_video_url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-white/5 px-4 py-2 text-sm font-medium text-white hover:bg-white/10"
              >
                Pitch video <ExternalLink className="h-3.5 w-3.5" />
              </a>
            )}
          </div>
        )}

        {(members?.length ?? 0) > 0 && (
          <section className="mt-12 border-t border-white/10 pt-8">
            <h2 className="text-xs font-semibold uppercase tracking-[0.2em] text-phosphor">
              Team
            </h2>
            <ul className="mt-4 space-y-2">
              {(members ?? []).map((m: any, i: number) => {
                const u = Array.isArray(m.user) ? m.user[0] : m.user;
                return (
                  <li
                    key={i}
                    className="flex flex-wrap items-center gap-2 text-sm text-white/80"
                  >
                    <span className="text-white">
                      {u?.full_name ?? "Member"}
                    </span>
                    {passHolders.has(m.user_id) && <FounderPassBadge />}
                    <span className="text-white/45">— {m.role}</span>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
      </article>
      <Footer />
    </main>
  );
}
