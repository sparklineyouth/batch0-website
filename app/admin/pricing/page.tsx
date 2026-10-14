import { Card } from "@/components/ui/card";
import { getSiteConfig } from "@/lib/site-config";
import { listPriceCents } from "@/lib/promo";
import { PricingForm } from "./pricing-form";

export const metadata = { title: "Pricing · Admin" };

// Dynamic: the promo config must never be served stale to the one screen
// whose job is to edit it.
export const dynamic = "force-dynamic";

export default async function AdminPricingPage() {
  const config = await getSiteConfig();
  const cohort = config.cohort;
  const listCents = cohort ? listPriceCents(cohort.priceCents) : 12999;

  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="font-display text-3xl font-bold tracking-[-0.02em] text-ink">
        Pricing
      </h1>
      <p className="mt-1 text-sm text-ink-faint">
        Site-wide discount. List price lives in Cohorts.
      </p>

      <Card className="mt-6">
        <PricingForm
          initial={{
            enabled: config.settings.promo.enabled,
            percent: config.settings.promo.percent,
            endsAt: config.settings.promo.endsAt,
          }}
          listPriceCents={listCents}
        />
      </Card>
    </div>
  );
}
