"use server";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { stripe } from "@/lib/stripe";
import { logAudit } from "@/lib/audit";

async function ensureAdmin() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("Not signed in");
  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  if (!profile || profile.role !== "admin") {
    throw new Error("Forbidden");
  }
}

export type CohortInput = {
  id?: string;
  name: string;
  starts_on?: string | null;
  ends_on?: string | null;
  capacity: number;
  status: "upcoming" | "active" | "completed" | "cancelled";
  price_cents: number;
};

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
  const productName = `SparkLine — ${args.name}`;

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
      // Price changed — archive the old one.
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

export async function saveCohort(input: CohortInput) {
  await ensureAdmin();
  const admin = createAdminClient();

  const payload = {
    name: input.name,
    starts_on: input.starts_on || null,
    ends_on: input.ends_on || null,
    capacity: input.capacity,
    status: input.status,
    price_cents: input.price_cents,
  };

  let cohortId = input.id ?? null;
  let existingProductId: string | null = null;
  let existingPriceId: string | null = null;

  if (cohortId) {
    const { data: existing, error: fetchErr } = await admin
      .from("cohorts")
      .select("stripe_product_id, stripe_price_id")
      .eq("id", cohortId)
      .single();
    if (fetchErr) throw new Error(fetchErr.message);
    existingProductId = existing?.stripe_product_id ?? null;
    existingPriceId = existing?.stripe_price_id ?? null;

    const { error } = await admin
      .from("cohorts")
      .update(payload)
      .eq("id", cohortId);
    if (error) throw new Error(error.message);
  } else {
    const { data: created, error } = await admin
      .from("cohorts")
      .insert(payload)
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    cohortId = created!.id;
  }

  // Sync to Stripe — best-effort so a Stripe outage doesn't block cohort
  // edits. Stored IDs are only updated if Stripe succeeded.
  try {
    const synced = await syncStripePrice({
      cohortId: cohortId!,
      name: input.name,
      priceCents: input.price_cents,
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
    payload: { name: input.name, price_cents: input.price_cents, status: input.status },
  });

  revalidatePath("/admin/cohorts");
}

export async function deleteCohort(id: string) {
  await ensureAdmin();
  const admin = createAdminClient();

  // Best-effort: archive the Stripe product so it doesn't keep showing
  // up as a sellable item even after the cohort is gone.
  const { data: cohort } = await admin
    .from("cohorts")
    .select("stripe_product_id, stripe_price_id")
    .eq("id", id)
    .single();
  if (cohort?.stripe_price_id) {
    try {
      await stripe.prices.update(cohort.stripe_price_id, { active: false });
    } catch {}
  }
  if (cohort?.stripe_product_id) {
    try {
      await stripe.products.update(cohort.stripe_product_id, { active: false });
    } catch {}
  }

  const { error } = await admin.from("cohorts").delete().eq("id", id);
  if (error) throw new Error(error.message);
  await logAudit({
    action: "cohort.deleted",
    targetType: "cohort",
    targetId: id,
  });
  // Cohort lookups feed several admin lists and student-facing pages —
  // invalidate them so a deleted cohort doesn't linger in dropdowns.
  revalidatePath("/admin/cohorts");
  revalidatePath("/admin/applications");
  revalidatePath("/admin/students");
  revalidatePath("/admin/teams");
}
