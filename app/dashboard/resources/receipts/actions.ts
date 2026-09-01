"use server";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { RECEIPT_KINDS } from "@/lib/receipts";

/**
 * Post a build receipt as the signed-in user. Runs on the user client so
 * RLS is the enforcement: insert requires user_id = auth.uid() AND an
 * accepted/paid/enrolled application or an enrollment.
 */
export async function postReceipt(input: {
  kind: string;
  body: string;
  linkUrl: string | null;
}): Promise<void> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not signed in");

  if (!RECEIPT_KINDS.some((k) => k.value === input.kind)) {
    throw new Error("Pick what kind of proof this is");
  }
  const body = input.body.trim();
  if (body.length < 3) throw new Error("Say what you actually did");
  if (body.length > 2000) throw new Error("Keep it under 2000 characters");
  const linkUrl = input.linkUrl?.trim() || null;
  if (linkUrl && !/^https?:\/\/.+/.test(linkUrl)) {
    throw new Error("Link must start with http(s)://");
  }

  // The receipt is stamped with the poster's cohort so the feed is
  // cohort-visible: enrollment first, else the accepted application.
  const [{ data: enrollment }, { data: app }] = await Promise.all([
    supabase
      .from("enrollments")
      .select("cohort_id")
      .eq("user_id", user.id)
      .limit(1)
      .maybeSingle(),
    supabase
      .from("applications")
      .select("cohort_id, status")
      .eq("user_id", user.id)
      .in("status", ["accepted", "paid", "enrolled"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  const cohortId = enrollment?.cohort_id ?? app?.cohort_id ?? null;

  const { error } = await supabase.from("build_receipts").insert({
    user_id: user.id,
    cohort_id: cohortId,
    kind: input.kind,
    body,
    link_url: linkUrl,
  });
  if (error) {
    throw new Error(
      error.message.includes("row-level security")
        ? "Receipts open up once your application is accepted."
        : error.message,
    );
  }
  revalidatePath("/dashboard/resources/receipts");
}

/** Delete a receipt — RLS allows your own rows, and admins for moderation. */
export async function deleteReceipt(id: string): Promise<void> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not signed in");
  const { error } = await supabase.from("build_receipts").delete().eq("id", id);
  if (error) throw new Error(error.message);
  revalidatePath("/dashboard/resources/receipts");
}
