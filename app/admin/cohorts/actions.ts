"use server";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertAdmin } from "@/lib/server-guards";
import { stripe } from "@/lib/stripe";
import { logAudit } from "@/lib/audit";
import { runAction, type ActionResult } from "@/lib/action-result";

export type CohortInput = {
  id?: string;
  name: string;
  cohort_number?: number | null;
  starts_on?: string | null;
  ends_on?: string | null;
  capacity: number;
  status: "upcoming" | "active" | "completed" | "cancelled";
  price_cents: number;
  /**
   * Optional explicit close-of-applications timestamp. When set, the
   * landing page hero shows a countdown ("Applications close in N
   * days"). Leave null to suppress the countdown — the global
   * `applications_open` setting still works either way.
   */
  applications_close_at?: string | null;
};

const ALLOWED_STATUSES = new Set([
  "upcoming",
  "active",
  "completed",
  "cancelled",
]);

/**
 * Sync a cohort's price to Stripe. Stripe doesn't allow editing existing
 * Price objects, so when the price changes we create a new one and
 * archive the old one. The Product is reused (and its name updated).
 */
async function syncStripePrice(args: {
  cohortId: string;
  name: string;
  priceCents: number;
  existingProductId: string | null;
  existingPriceId: string | null;
}): Promise<{ productId: string; priceId: string }> {
  const productName = `SparkLine Youth — ${args.name}`;

  let productId = args.existingProductId;
  if (productId) {
    try {
      await stripe.products.update(productId, {
        name: productName,
        active: true,
        metadata: { cohort_id: args.cohortId },
      });
    } catch {
      // Product was deleted in Stripe; recreate.
      productId = null;
    }
  }
  if (!productId) {
    const product = await stripe.products.create({
      name: productName,
      metadata: { cohort_id: args.cohortId },
    });
    productId = product.id;
  }

  // If the existing Price still matches, reuse it.
  if (args.existingPriceId) {
    try {
      const existing = await stripe.prices.retrieve(args.existingPriceId);
      if (
        existing.active &&
        existing.unit_amount === args.priceCents &&
        existing.currency === "usd" &&
        existing.product === productId
      ) {
        return { productId, priceId: existing.id };
      }
      try {
        await stripe.prices.update(args.existingPriceId, { active: false });
      } catch {
        // best effort
      }
    } catch {
      // existing price not retrievable; fall through to create a new one
    }
  }

  const price = await stripe.prices.create({
    product: productId,
    unit_amount: args.priceCents,
    currency: "usd",
    metadata: { cohort_id: args.cohortId },
  });
  return { productId, priceId: price.id };
}

export async function saveCohort(
  input: CohortInput,
): Promise<ActionResult<{ id: string }>> {
  return runAction({ name: "saveCohort" }, async () => {
    await assertAdmin();

    // Validate up front so the action returns a friendly message rather
    // than a raw Postgres constraint error.
    const name = (input.name ?? "").trim();
    if (!name) throw new Error("Name is required");
    if (!ALLOWED_STATUSES.has(input.status)) {
      throw new Error(`Invalid status "${input.status}"`);
    }
    const capacity = Number(input.capacity);
    if (!Number.isFinite(capacity) || capacity < 1) {
      throw new Error("Capacity must be at least 1");
    }
    const priceCents = Number(input.price_cents);
    if (!Number.isFinite(priceCents) || priceCents < 0) {
      throw new Error("Price must be 0 or more cents");
    }
    const cohortNumber =
      input.cohort_number == null || input.cohort_number === ("" as any)
        ? null
        : Number(input.cohort_number);
    if (cohortNumber !== null && (!Number.isFinite(cohortNumber) || cohortNumber < 1)) {
      throw new Error("Cohort # must be a positive integer or blank");
    }
    const startsOn = input.starts_on?.trim() || null;
    const endsOn = input.ends_on?.trim() || null;
    if (startsOn && endsOn && endsOn < startsOn) {
      throw new Error("End date is before the start date");
    }

    const admin = createAdminClient();
    const basePayload = {
      name,
      starts_on: startsOn,
      ends_on: endsOn,
      capacity,
      status: input.status,
      price_cents: priceCents,
    };
    // cohort_number is a newer column (migration 0017),
    // applications_close_at lands in 0029. We always pass them
    // (including null) so editing can clear values; if a migration
    // hasn't landed the fallback path drops the optional column.
    const payload: Record<string, any> = {
      ...basePayload,
      cohort_number: cohortNumber,
      applications_close_at: input.applications_close_at?.trim() || null,
    };

    function isUnknownColumnError(err: any) {
      const msg = String(err?.message ?? err);
      return (
        /column .*cohort_number.* does not exist/i.test(msg) ||
        /column .*applications_close_at.* does not exist/i.test(msg)
      );
    }

    let cohortId = input.id ?? null;
    let existingProductId: string | null = null;
    let existingPriceId: string | null = null;

    if (cohortId) {
      const { data: existing, error: fetchErr } = await admin
        .from("cohorts")
        .select("stripe_product_id, stripe_price_id")
        .eq("id", cohortId)
        .maybeSingle();
      if (fetchErr) throw new Error(`Lookup failed: ${fetchErr.message}`);
      if (!existing) throw new Error("Cohort not found");
      existingProductId = existing.stripe_product_id ?? null;
      existingPriceId = existing.stripe_price_id ?? null;

      let { error } = await admin
        .from("cohorts")
        .update(payload)
        .eq("id", cohortId);
      if (error && isUnknownColumnError(error)) {
        ({ error } = await admin
          .from("cohorts")
          .update(basePayload)
          .eq("id", cohortId));
      }
      if (error) throw new Error(`Save failed: ${error.message}`);
    } else {
      let { data: created, error } = await admin
        .from("cohorts")
        .insert(payload)
        .select("id")
        .single();
      if (error && isUnknownColumnError(error)) {
        ({ data: created, error } = await admin
          .from("cohorts")
          .insert(basePayload)
          .select("id")
          .single());
      }
      if (error) throw new Error(`Create failed: ${error.message}`);
      cohortId = created!.id;
    }

    // Sync to Stripe — best-effort so a Stripe outage doesn't block
    // cohort edits. The stored IDs are only updated if Stripe succeeded.
    try {
      const synced = await syncStripePrice({
        cohortId: cohortId!,
        name,
        priceCents,
        existingProductId,
        existingPriceId,
      });
      await admin
        .from("cohorts")
        .update({
          stripe_product_id: synced.productId,
          stripe_price_id: synced.priceId,
        })
        .eq("id", cohortId!);
    } catch (err) {
      console.error("[cohorts] Stripe sync failed:", err);
    }

    await logAudit({
      action: input.id ? "cohort.updated" : "cohort.created",
      targetType: "cohort",
      targetId: cohortId!,
      payload: { name, price_cents: priceCents, status: input.status },
    });

    revalidatePath("/admin/cohorts");
    revalidatePath("/");
    revalidatePath("/apply");
    revalidatePath("/opengraph-image");

    return { id: cohortId! };
  });
}

export async function deleteCohort(id: string): Promise<ActionResult> {
  return runAction({ name: "deleteCohort" }, async () => {
    await assertAdmin();
    const admin = createAdminClient();

    const { data: cohort } = await admin
      .from("cohorts")
      .select("stripe_product_id, stripe_price_id")
      .eq("id", id)
      .maybeSingle();
    if (cohort?.stripe_price_id) {
      try {
        await stripe.prices.update(cohort.stripe_price_id, { active: false });
      } catch {}
    }
    if (cohort?.stripe_product_id) {
      try {
        await stripe.products.update(cohort.stripe_product_id, {
          active: false,
        });
      } catch {}
    }

    const { error } = await admin.from("cohorts").delete().eq("id", id);
    if (error) throw new Error(`Delete failed: ${error.message}`);
    await logAudit({
      action: "cohort.deleted",
      targetType: "cohort",
      targetId: id,
    });
    revalidatePath("/admin/cohorts");
    revalidatePath("/admin/applications");
    revalidatePath("/admin/students");
    revalidatePath("/admin/teams");
    revalidatePath("/");
    revalidatePath("/apply");
    revalidatePath("/opengraph-image");
  });
}
