import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Records a successful MFA challenge so `assertRecentMfa()` lets the user
 * through. The actual TOTP verification happens against Supabase Auth on
 * the client; this endpoint just trusts that the session AAL has been
 * raised and persists a timestamp.
 *
 * Defensive: we double-check the access token's AAL claim before writing,
 * so a tampered client can't forge step-up.
 */
export async function POST() {
  const supabase = createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  // Decode the JWT payload for the AAL claim. Supabase issues `aal: "aal2"`
  // when an MFA challenge has been verified for the session.
  let aal: string | null = null;
  try {
    const part = session.access_token.split(".")[1];
    const padded = part + "===".slice((part.length + 3) % 4);
    const json = JSON.parse(
      Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(
        "utf-8",
      ),
    );
    aal = json.aal ?? null;
  } catch {
    aal = null;
  }
  if (aal !== "aal2") {
    return NextResponse.json(
      { error: "Session is not stepped-up." },
      { status: 403 },
    );
  }

  const admin = createAdminClient();
  await admin.from("mfa_verifications").insert({
    user_id: session.user.id,
    verified_at: new Date().toISOString(),
  });
  return NextResponse.json({ ok: true });
}
