import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendEmail } from "@/lib/email/send";
import { Templates } from "@/lib/email/templates";
import { notify } from "@/lib/notifications";
import { roleHome } from "@/lib/auth";

// Accept only same-origin relative paths so a tampered ?next= can't
// redirect the user off-site after they sign in.
function safeNext(raw: string | null): string | null {
  if (!raw) return null;
  if (!raw.startsWith("/") || raw.startsWith("//")) return null;
  return raw;
}

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const nextParam = safeNext(searchParams.get("next"));

  if (!code) {
    return NextResponse.redirect(
      `${origin}/login?error=Could%20not%20authenticate`,
    );
  }

  const supabase = createClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    console.error("[auth/callback] exchangeCodeForSession failed:", error);
    return NextResponse.redirect(
      `${origin}/login?error=Could%20not%20authenticate`,
    );
  }

  // Default destination: the user's role home. Falls back to /dashboard
  // for synthesized profiles (which default to "student"). We resolve this
  // *before* the welcome flow so a flaky email/notify doesn't change the
  // redirect target.
  let destination = nextParam ?? "/dashboard";

  // First-time confirmation: send the welcome email + in-app notification
  // (best effort; failures are swallowed so a flaky integration doesn't
  // break login).
  try {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (user) {
      const admin = createAdminClient();
      const { data: profile } = await admin
        .from("profiles")
        .select("full_name, role")
        .eq("id", user.id)
        .maybeSingle();

      if (!nextParam) {
        destination = roleHome((profile?.role ?? "student") as any);
      }

      if (user.email) {
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
            title: "Welcome to batch0",
            body: "Your account is ready. Apply when you're ready.",
            link: "/apply",
          });
        }
      }
    }
  } catch (err) {
    console.error("[auth/callback] welcome flow failed", err);
  }

  return NextResponse.redirect(`${origin}${destination}`);
}
