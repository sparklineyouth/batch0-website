import Link from "next/link";
import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import Navbar from "@/components/navbar";
import Footer from "@/components/footer";

export async function generateMetadata({
  params,
}: {
  params: { slug: string };
}) {
  const admin = createAdminClient();
  const { data: cohort } = await admin
    .from("cohorts")
    .select("name")
    .eq("slug", params.slug)
    .maybeSingle();
  return {
    title: cohort ? `${cohort.name} · SparkLine showcase` : "Showcase",
    description: cohort
      ? `Startups built in ${cohort.name} at SparkLine.`
      : undefined,
  };
}

export default async function CohortShowcase({
  params,
}: {
  params: { slug: string };
}) {
  const admin = createAdminClient();
  const { data: cohort } = await admin
    .from("cohorts")
    .select("id, name, slug, starts_on, ends_on")
    .eq("slug", params.slug)
    .maybeSingle();
  if (!cohort) notFound();

  const { data: teams } = await admin
    .from("teams")
    .select("id, name, slug, tagline, description, logo_url, website_url")
    .eq("cohort_id", cohort.id)
    .eq("is_public", true)
    .order("name");

  return (
    <main className="relative min-h-screen overflow-hidden bg-black text-white">
      <Navbar />
      <section className="relative mx-auto max-w-6xl px-6 pt-32 pb-20">
        <p className="text-sm font-medium uppercase tracking-[0.2em] text-spark">
          Showcase · {cohort.name}
        </p>
        <h1 className="mt-3 text-4xl font-bold tracking-tight md:text-6xl">
          Startups built at SparkLine
        </h1>
        <p className="mt-5 max-w-2xl text-lg text-white/60">
          Real startups built by high schoolers in the {cohort.name} cohort.
          Click through to see what they're working on.
        </p>

        <div className="mt-12 grid gap-5 md:grid-cols-2 lg:grid-cols-3">
          {(teams?.length ?? 0) === 0 ? (
            <p className="text-sm text-white/50">
              No teams have published yet. Check back after Demo Day.
            </p>
          ) : (
            (teams ?? []).map((t: any) => (
              <Link
                key={t.id}
                href={`/cohort/${cohort.slug}/teams/${t.slug}`}
                className="group rounded-2xl border border-white/10 bg-zinc-900/40 p-6 transition hover:border-spark/40 hover:bg-zinc-900/60"
              >
                {t.logo_url ? (
                  <img
                    src={t.logo_url}
                    alt={`${t.name} logo`}
                    className="mb-4 h-10 w-10 rounded-lg object-cover"
                  />
                ) : (
                  <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-lg bg-spark/15 text-spark font-bold">
                    {t.name.charAt(0)}
                  </div>
                )}
                <h3 className="text-lg font-semibold text-white group-hover:text-spark">
                  {t.name}
                </h3>
                {t.tagline && (
                  <p className="mt-1 text-sm text-white/65">{t.tagline}</p>
                )}
              </Link>
            ))
          )}
        </div>
      </section>
      <Footer />
    </main>
  );
}
