import { NextResponse } from "next/server";
import { activePromo } from "@/lib/promo";
import { loadPromoConfig } from "@/lib/promo-settings";

// The live promo, for the one surface that can't read it at render time.
//
// SaleBanner lives in the statically generated root layout, so it can't be
// handed the admin-set promo as a prop without turning every page dynamic. It
// instead fetches this on mount and corrects itself — which is also what makes
// an admin's percent/deadline edit show up on the banner across all 135
// prerendered blog posts without a redeploy.
//
// Public and non-sensitive (the same numbers the marketing page already
// prints), so no auth. Short-lived cache: an admin edit should surface within
// a minute, and the banner is not worth a DB read on every request.
export const dynamic = "force-dynamic";

export async function GET() {
  const config = await loadPromoConfig();
  const promo = activePromo(new Date(), config);
  return NextResponse.json(
    promo
      ? {
          active: true,
          percent: promo.percent,
          // The prose deadline ("September 9"), empty for an open-ended promo.
          longDeadline: promo.longDeadline,
          // The raw instant, so the banner's live countdown ticks against the
          // exact cutoff rather than midnight of the display date.
          endsAt: config.endsAt,
        }
      : { active: false },
    {
      headers: {
        "Cache-Control": "public, max-age=60, stale-while-revalidate=300",
      },
    },
  );
}
