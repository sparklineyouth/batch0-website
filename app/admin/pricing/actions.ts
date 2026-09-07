"use server";
import { revalidatePath, revalidateTag } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { SITE_CONFIG_TAG } from "@/lib/site-config";
import { assertPermission } from "@/lib/server-guards";
import { logAudit } from "@/lib/audit";
import { runAction, type ActionResult } from "@/lib/action-result";

export type PricingSettingsInput = {
  /** Master switch for the tuition promotion. */
  enabled: boolean;
  /** Whole-number percent off list price, 0–90. */
  percent: number;
  /**
   * ISO instant the promo ends, or null for an open-ended promo with no
   * deadline. The form sends an absolute instant (converted from the admin's
   * local datetime picker), so there is no timezone ambiguity to resolve here.
   */
  endsAt: string | null;
};

/**
 * Write the admin-set promotion into `site_settings`.
 *
 * The three keys map 1:1 to what `resolvePromoConfig` reads. Saving revalidates
 * the same tag and route caches as the main settings action, so the new
 * percent/deadline reaches the marketing site, checkout, and the dashboards on
 * the next request rather than waiting out the ISR window.
 */
export async function savePricingSettings(
  input: PricingSettingsInput,
): Promise<ActionResult> {
  return runAction({ name: "savePricingSettings" }, async () => {
    await assertPermission("settings.manage");

    if (
      !Number.isFinite(input.percent) ||
      input.percent < 0 ||
      input.percent > 90
    ) {
      throw new Error("Discount must be between 0 and 90 percent");
    }
    if (input.endsAt !== null) {
      if (
        typeof input.endsAt !== "string" ||
        Number.isNaN(new Date(input.endsAt).getTime())
      ) {
        throw new Error("End date is not a valid date");
      }
    }

    const percent = Math.round(input.percent);
    const admin = createAdminClient();
    const now = new Date().toISOString();
    const rows = [
      { key: "promo_enabled", value: input.enabled, updated_at: now },
      { key: "promo_percent", value: percent, updated_at: now },
      { key: "promo_ends_at", value: input.endsAt, updated_at: now },
    ];
    const { error } = await admin
      .from("site_settings")
      .upsert(rows, { onConflict: "key" });
    if (error) throw new Error(`Save failed: ${error.message}`);

    await logAudit({
      action: "settings.updated",
      payload: {
        promo_enabled: input.enabled,
        promo_percent: percent,
        promo_ends_at: input.endsAt,
      },
    });

    // Same fan-out as saveSiteSettings: one tag covers every prerendered
    // surface that reads the price (homepage, program, sponsors, challenges,
    // blog), and the explicit paths cover the dynamic price surfaces.
    revalidateTag(SITE_CONFIG_TAG);
    revalidatePath("/admin/pricing");
    revalidatePath("/admin/cohorts");
    revalidatePath("/");
    revalidatePath("/program");
    revalidatePath("/apply");
    revalidatePath("/signup");
    revalidatePath("/opengraph-image");
    revalidatePath("/dashboard/application");
    revalidatePath("/dashboard/accepted");
  });
}
