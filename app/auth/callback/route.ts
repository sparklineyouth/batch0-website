import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendEmail } from "@/lib/email/send";
import { Templates } from "@/lib/email/templates";
import { notify } from "@/lib/notifications";

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/dashboard";

  if (!code) {
    return NextResponse.redirect(
      `${origin}/login?error=Could%20not%20authenticate`,
    );
  }

  const supabase = createClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    return NextResponse.redirect(
      `${origin}/login?error=Could%20not%20authenticate`,
    );
  }

  // First-time confirmation: send the welcome email + in-app notification
  // (best effort; failures are swallowed so a flaky integration doesn't
  // break login).
  try {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (user?.email) {
      const admin = createAdminClient();
      const { data: profile } = await admin
        .from("profiles")
        .select("full_name")
        .eq("id", user.id)
        .maybeSingle();

      // Avoid re-notifying on every login: only fire if there's no welcome
      // notification yet.
      const { data: existing } = await admin
        .from("notifications")
        .select("id")
        .eq("user_id", user.id)
        .eq("type", "welcome")
        .limit(1);
      if (!existing || existing.length === 0) {
        const t = Templates.welcome({ name: profile?.full_name ?? null });
        await sendEmail({ to: user.email, subject: t.subject, html: t.html });
        await notify({
          userId: user.id,
          type: "welcome",
          title: "Welcome to SparkLine",
          body: "Your account is ready. Apply when you're ready.",
          link: "/apply",
        });
      }
    }
  } catch (err) {
    console.error("[auth/callback] welcome flow failed", err);
  }

  return NextResponse.redirect(`${origin}${next}`);
}
