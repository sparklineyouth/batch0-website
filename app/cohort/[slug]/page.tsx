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
    .select("name, landing_headline, landing_subhead")
    .eq("slug", params.slug)
    .maybeSingle();
  if (!cohort) return { title: "Showcase · SparkLine" };
  return {
    title: `${cohort.name} · SparkLine`,
    description:
      (cohort as any).landing_subhead ||
      `Startups built in ${cohort.name} at SparkLine.`,
    openGraph: {
      title: (cohort as any).landing_headline ?? cohort.name,
      description:
        (cohort as any).landing_subhead ||
        `Startups built in ${cohort.name} at SparkLine.`,
    },
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
    .select(
      "id, name, slug, starts_on, ends_on, landing_headline, landing_subhead, landing_cta_label, accent_hex, hero_image_url",
    )
    .eq("slug", params.slug)
    .maybeSingle();
  if (!cohort) notFound();

  const { data: teams } = await admin
    .from("teams")
    .select("id, name, slug, tagline, description, logo_url, website_url")
    .eq("cohort_id", cohort.id)
    .eq("is_public", true)
    .order("name");

  const c = cohort as any;
  const accent = isValidHex(c.accent_hex) ? c.accent_hex : "#facc15";
  // CSS var so we can theme accents per-cohort without compiling a new
  // Tailwind palette. Used on the eyebrow + hero badge below.
  const accentStyle = {
    ["--accent" as any]: accent,
  } as React.CSSProperties;

  return (
    <main
      style={accentStyle}
      className="relative min-h-screen overflow-hidden bg-black text-white"
    >
      <Navbar />
      <section className="relative mx-auto max-w-6xl px-6 pb-20 pt-32">
        <p
          className="text-sm font-medium uppercase tracking-[0.2em]"
          style={{ color: "var(--accent)" }}
        >
          Showcase · {cohort.name}
        </p>
        <h1 className="mt-3 text-4xl font-bold tracking-tight md:text-6xl">
          {c.landing_headline || "Startups built at SparkLine"}
        </h1>
        <p className="mt-5 max-w-2xl text-lg text-white/60">
          {c.landing_subhead ||
            `Real startups built by high schoolers in the ${cohort.name} cohort. Click through to see what they're working on.`}
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Link
            href="/apply"
            className="inline-flex items-center rounded-full px-5 py-2.5 text-sm font-semibold text-black transition active:scale-95"
            style={{ background: "var(--accent)" }}
          >
            {c.landing_cta_label || "Apply to the next cohort"}
          </Link>
          <Link
            href="/"
            className="inline-flex items-center rounded-full border border-white/20 px-5 py-2.5 text-sm font-medium text-white/85 transition hover:border-white/40"
          >
            About SparkLine
          </Link>
        </div>

        {c.hero_image_url && (
          <div className="mt-10 overflow-hidden rounded-2xl border border-white/10">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={c.hero_image_url}
              alt={`${cohort.name} hero`}
              className="w-full"
            />
          </div>
        )}

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
                className="group rounded-2xl border border-white/10 bg-zinc-900/40 p-6 transition hover:bg-zinc-900/60"
                style={{ borderColor: "rgba(255,255,255,0.1)" }}
              >
                {t.logo_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={t.logo_url}
                    alt={`${t.name} logo`}
                    className="mb-4 h-10 w-10 rounded-lg object-cover"
                  />
                ) : (
                  <div
                    className="mb-4 flex h-10 w-10 items-center justify-center rounded-lg font-bold"
                    style={{
                      background: "var(--accent)",
                      color: "#000",
                    }}
                  >
                    {t.name.charAt(0)}
                  </div>
                )}
                <h3 className="text-lg font-semibold text-white">{t.name}</h3>
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

function isValidHex(s: unknown): s is string {
  return typeof s === "string" && /^#[0-9a-fA-F]{6}$/.test(s);
}
