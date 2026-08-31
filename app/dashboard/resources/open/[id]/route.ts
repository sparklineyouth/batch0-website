import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Open a resource, recording that it was opened.
 *
 * Resources used to be a bare `<a href>` straight to a signed storage URL or
 * an external site, which meant nobody could answer "did they ever look at
 * the pre-work?". Routing the click through here records the view and then
 * redirects, so the student experience is unchanged — one click, the file
 * opens — and the admin side gains the only signal it was missing.
 *
 * Minting the signed URL at click time rather than at page render is a second
 * benefit that fell out of it: the old page signed every URL for an hour when
 * it loaded, so a dashboard left open in a tab handed out links that were
 * already dead. Here the URL is always seconds old.
 */
export async function GET(
  _req: Request,
  { params }: { params: { id: string } },
) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.redirect(
      new URL(
        `/login?next=/dashboard/resources/open/${params.id}`,
        process.env.NEXT_PUBLIC_SITE_URL ?? "https://batch0.org",
      ),
    );
  }

  // Read the resource through the caller's own client, not the admin one, so
  // the RLS policy that decides who may see which cohort's resources still
  // applies. Using the service role here would turn this route into a way to
  // read any resource by guessing an id.
  const { data: resource } = await supabase
    .from("resources")
    .select("id, storage_path, external_url")
    .eq("id", params.id)
    .maybeSingle();

  const base = process.env.NEXT_PUBLIC_SITE_URL ?? "https://batch0.org";
  if (!resource) {
    return NextResponse.redirect(new URL("/dashboard/resources?missing=1", base));
  }

  // Best-effort: a failed write must never cost the student the file they
  // clicked on. The RPC takes the user from auth.uid(), so it can only ever
  // record the caller's own view.
  try {
    await supabase.rpc("record_resource_view", { p_resource_id: resource.id });
  } catch (err) {
    console.error("[resources] view not recorded", resource.id, err);
  }

  if (resource.external_url) {
    return NextResponse.redirect(resource.external_url);
  }
  if (resource.storage_path) {
    const admin = createAdminClient();
    const { data: signed } = await admin.storage
      .from("resources")
      .createSignedUrl(resource.storage_path, 60 * 10);
    if (signed?.signedUrl) return NextResponse.redirect(signed.signedUrl);
  }
  return NextResponse.redirect(new URL("/dashboard/resources?unavailable=1", base));
}
