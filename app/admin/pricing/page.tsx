import { createAdminClient } from "@/lib/supabase/admin";
import { Card } from "@/components/ui/card";
import { getSiteConfig } from "@/lib/site-config";
import { listPriceCents } from "@/lib/promo";
import { PricingForm } from "./pricing-form";
import { RevenueExplorer } from "./revenue-explorer";

export const metadata = { title: "Pricing & revenue · Admin" };

// Dynamic: every number here is live analytics, and the promo config must
// never be served stale to the one screen whose job is to edit it.
export const dynamic = "force-dynamic";

async function countApplications(
  admin: ReturnType<typeof createAdminClient>,
  cohortId: string,
  statuses: string[],
): Promise<number> {
  const { count } = await admin
    .from("applications")
    .select("id", { count: "exact", head: true })
    .eq("cohort_id", cohortId)
    .in("status", statuses);
  return count ?? 0;
}

export default async function AdminPricingPage() {
  const admin = createAdminClient();
  const config = await getSiteConfig();
  const cohort = config.cohort;

  // The list price (regional overrides stripped) and the price we actually
  // charge today after the promo — the demand curve anchors on the latter,
  // because that is the price at which the conversions below were observed.
  const listCents = cohort ? listPriceCents(cohort.priceCents) : 12999;
  const chargedCents = config.derived.priceCents;

  // Live funnel for the active cohort. Accepted pool = everyone we admitted
  // (paid or not); conversions = the admitted who paid. Their ratio is today's
  // conversion rate, the thing the model is pinned to.
  let acceptedPool = 0;
  let conversions = 0;
  let submitted = 0;
  let revenueToDateCents = 0;
  if (cohort?.id) {
    const [accepted, paid, submittedCount, payments] = await Promise.all([
      countApplications(admin, cohort.id, ["accepted", "paid", "enrolled"]),
      countApplications(admin, cohort.id, ["paid", "enrolled"]),
      countApplications(admin, cohort.id, [
        "submitted",
        "accepted",
        "rejected",
        "paid",
        "enrolled",
        "waitlisted",
      ]),
      admin
        .from("payments")
        .select("amount_cents")
        .eq("cohort_id", cohort.id)
        .eq("status", "succeeded"),
    ]);
    acceptedPool = accepted;
    conversions = paid;
    submitted = submittedCount;
    revenueToDateCents = (payments.data ?? []).reduce(
      (sum, r: { amount_cents: number | null }) => sum + (r.amount_cents ?? 0),
      0,
    );
  }

  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="font-display text-3xl font-bold tracking-[-0.02em] text-ink">
        Pricing &amp; revenue
      </h1>
      <p className="mt-1 text-sm text-ink-faint">
        Set the tuition discount — it applies across the marketing site,
        checkout, and the acceptance email on the next request — and model which
        price would earn the most, from this cohort&apos;s own funnel.
      </p>

      <Card className="mt-6">
        <h2 className="mb-1 text-sm font-semibold uppercase tracking-wider text-ink-faint">
          Discount control
        </h2>
        <p className="mb-5 text-sm text-ink-soft">
          List price is set per cohort in{" "}
          <span className="font-medium text-ink">Cohorts</span>. This is the
          site-wide sale applied on top of it.
        </p>
        <PricingForm
          initial={{
            enabled: config.settings.promo.enabled,
            percent: config.settings.promo.percent,
            endsAt: config.settings.promo.endsAt,
          }}
          listPriceCents={listCents}
        />
      </Card>

      <Card className="mt-6">
        <h2 className="mb-1 text-sm font-semibold uppercase tracking-wider text-ink-faint">
          Revenue model
        </h2>
        <RevenueExplorer
          cohortName={config.derived.cohortHeadline}
          referencePriceCents={chargedCents}
          listPriceCents={listCents}
          acceptedPool={acceptedPool}
          conversions={conversions}
          submitted={submitted}
          capacity={cohort?.capacity ?? 0}
          revenueToDateCents={revenueToDateCents}
          hasCohort={Boolean(cohort?.id)}
        />
      </Card>
    </div>
  );
}
