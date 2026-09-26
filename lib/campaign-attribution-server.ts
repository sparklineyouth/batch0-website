import "server-only";
import { cookies } from "next/headers";
import { createAdminClient } from "@/lib/supabase/admin";
import { CAMPAIGN_COOKIE, persistCampaignAttribution } from "@/lib/campaign-attribution";

/** Called only after an authenticated applicant's own application was saved. */
export async function attachCampaignAttribution(applicationId: string) {
  try {
    const raw = (await cookies()).get(CAMPAIGN_COOKIE)?.value;
    if (!raw) return;
    const saved = await persistCampaignAttribution(createAdminClient(), applicationId, raw);
    if (!saved) console.error("[campaign-attribution] Could not persist application source; check migration 0086 and database availability.");
  } catch {
    // Measurement failure must not prevent an application or send duplicate mail.
    console.error("[campaign-attribution] Could not persist application source.");
  }
}
