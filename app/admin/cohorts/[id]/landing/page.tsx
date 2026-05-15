import Link from "next/link";
import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdmin } from "@/lib/auth";
import { Card } from "@/components/ui/card";
import { LandingForm } from "./landing-form";

export const metadata = { title: "Cohort landing · Admin" };

export default async function CohortLandingPage({
  params,
}: {
  params: { id: string };
}) {
  await requireAdmin();
  const admin = createAdminClient();
  const { data: cohort } = await admin
    .from("cohorts")
    .select(
      "id, name, slug, landing_headline, landing_subhead, landing_cta_label, accent_hex, hero_image_url",
    )
    .eq("id", params.id)
    .maybeSingle();
  if (!cohort) notFound();

  return (
    <div className="mx-auto max-w-3xl">
      <Link
        href="/admin/cohorts"
        className="text-sm text-white/55 hover:text-white"
      >
        ← Cohorts
      </Link>
      <h1 className="mt-3 text-3xl font-bold tracking-tight">
        {cohort.name} landing
      </h1>
      <p className="mt-1 text-sm text-white/55">
        Override the public landing copy + accent color for this cohort. Live
        at{" "}
        <Link
          href={`/cohort/${cohort.slug}`}
          className="text-spark hover:underline"
        >
          /cohort/{cohort.slug}
        </Link>
        .
      </p>
      <Card className="mt-6">
        <LandingForm
          initial={{
            id: cohort.id,
            landing_headline: cohort.landing_headline ?? "",
            landing_subhead: cohort.landing_subhead ?? "",
            landing_cta_label: cohort.landing_cta_label ?? "",
            accent_hex: cohort.accent_hex ?? "",
            hero_image_url: cohort.hero_image_url ?? "",
          }}
        />
      </Card>
    </div>
  );
}
