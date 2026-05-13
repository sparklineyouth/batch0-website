import Link from "next/link";
import { redirect } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import Navbar from "@/components/navbar";
import Footer from "@/components/footer";

export const metadata = {
  title: "Showcase · SparkLine",
  description: "Startups built by high-school founders at SparkLine.",
};

export default async function ShowcaseIndex() {
  const admin = createAdminClient();

  const { data: teams } = await admin
    .from("teams")
    .select("id, cohort_id")
    .eq("is_public", true);

  const cohortIds = Array.from(
    new Set((teams ?? []).map((t: any) => t.cohort_id).filter(Boolean)),
  );

  if (cohortIds.length === 0) {
    return (
      <main className="relative min-h-screen overflow-hidden bg-black text-white">
        <Navbar />
        <section className="relative mx-auto max-w-3xl px-6 pt-32 pb-20 text-center">
          <p className="text-sm font-medium uppercase tracking-[0.2em] text-spark">
            Showcase
          </p>
          <h1 className="mt-3 text-4xl font-bold tracking-tight md:text-5xl">
            Coming soon
          </h1>
          <p className="mx-auto mt-5 max-w-xl text-lg text-white/60">
            Our first cohort is still building. Check back after Demo Day to
            meet the startups.
          </p>
        </section>
        <Footer />
      </main>
    );
  }

  const { data: cohorts } = await admin
    .from("cohorts")
    .select("id, name, slug, starts_on, ends_on, status")
    .in("id", cohortIds)
    .order("starts_on", { ascending: false, nullsFirst: false });

  // If only one cohort has public teams, skip the index and send the
  // visitor straight to it — saves a click and matches the user's mental
  // model when there's nothing to choose between.
  if ((cohorts?.length ?? 0) === 1 && cohorts![0].slug) {
    redirect(`/cohort/${cohorts![0].slug}`);
  }

  const counts = new Map<string, number>();
  for (const t of teams ?? []) {
    counts.set(t.cohort_id, (counts.get(t.cohort_id) ?? 0) + 1);
  }

  return (
    <main className="relative min-h-screen overflow-hidden bg-black text-white">
      <Navbar />
      <section className="relative mx-auto max-w-6xl px-6 pt-32 pb-20">
        <p className="text-sm font-medium uppercase tracking-[0.2em] text-spark">
          Showcase
        </p>
        <h1 className="mt-3 text-4xl font-bold tracking-tight md:text-6xl">
          Startups from SparkLine
        </h1>
        <p className="mt-5 max-w-2xl text-lg text-white/60">
          Real startups built by high schoolers. Pick a cohort to see what
          they shipped.
        </p>

        <div className="mt-12 grid gap-5 md:grid-cols-2 lg:grid-cols-3">
          {(cohorts ?? []).map((c: any) => {
            if (!c.slug) return null;
            const count = counts.get(c.id) ?? 0;
            return (
              <Link
                key={c.id}
                href={`/cohort/${c.slug}`}
                className="group block rounded-2xl border border-white/10 bg-zinc-900/40 p-6 transition hover:border-spark/40 hover:bg-zinc-900/60"
              >
                <h3 className="text-xl font-semibold text-white group-hover:text-spark">
                  {c.name}
                </h3>
                <p className="mt-1 text-sm text-white/60">
                  {count} {count === 1 ? "startup" : "startups"}
                </p>
              </Link>
            );
          })}
        </div>
      </section>
      <Footer />
    </main>
  );
}
