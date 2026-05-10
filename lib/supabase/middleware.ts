import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

type CookiesToSet = {
  name: string;
  value: string;
  options: CookieOptions;
}[];

export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: CookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  // IMPORTANT: do not put logic between createServerClient and getUser().
  // getUser() also refreshes the session if needed, which writes new cookies
  // onto `response` via setAll above. Any redirect we return must carry
  // those cookies forward or the user will be silently logged out.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const path = request.nextUrl.pathname;
  const protectedPath =
    path.startsWith("/dashboard") ||
    path.startsWith("/admin") ||
    path.startsWith("/mentor") ||
    path.startsWith("/investor") ||
    path.startsWith("/apply");
  const authPath = path === "/login" || path === "/signup";

  function redirectTo(pathname: string, search?: string) {
    const url = request.nextUrl.clone();
    url.pathname = pathname;
    url.search = search ?? "";
    const redirect = NextResponse.redirect(url);
    // Carry over any auth cookies that getUser() may have refreshed,
    // otherwise the session is dropped on every redirect.
    response.cookies.getAll().forEach((c) => {
      redirect.cookies.set(c.name, c.value, c);
    });
    return redirect;
  }

  // Bounce legacy /professor URLs to the new /mentor area.
  if (path === "/professor" || path.startsWith("/professor/")) {
    const rest = path.slice("/professor".length);
    return redirectTo(`/mentor${rest}`, request.nextUrl.search);
  }

  if (protectedPath && !user) {
    return redirectTo("/login", `?next=${encodeURIComponent(path)}`);
  }

  if (authPath && user) {
    return redirectTo("/dashboard");
  }

  // Hard-block: any non-admin signed-in user with a pending fine can
  // only reach the pay-fine screen + billing + signout until paid or
  // waived. Admins bypass so they can still hit /admin to waive.
  if (
    user &&
    (path.startsWith("/dashboard") ||
      path.startsWith("/apply") ||
      path.startsWith("/mentor") ||
      path.startsWith("/investor")) &&
    !path.startsWith("/dashboard/billing") &&
    !path.startsWith("/dashboard/pay-fine") &&
    !path.startsWith("/auth")
  ) {
    const { data: pendingFine } = await supabase
      .from("user_charges")
      .select("id")
      .eq("user_id", user.id)
      .eq("kind", "fine")
      .eq("status", "pending")
      .limit(1)
      .maybeSingle();
    if (pendingFine) {
      const { data: blockProfile } = await supabase
        .from("profiles")
        .select("role")
        .eq("id", user.id)
        .maybeSingle();
      if (blockProfile?.role !== "admin") {
        return redirectTo("/dashboard/pay-fine");
      }
    }
  }

  if (
    (path.startsWith("/admin") ||
      path.startsWith("/mentor") ||
      path.startsWith("/investor")) &&
    user
  ) {
    const { data: profile } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .maybeSingle();
    const role = profile?.role;
    if (path.startsWith("/admin") && role !== "admin") {
      return redirectTo("/dashboard");
    }
    if (
      path.startsWith("/mentor") &&
      role !== "admin" &&
      role !== "mentor"
    ) {
      return redirectTo("/dashboard");
    }
    if (
      path.startsWith("/investor") &&
      role !== "admin" &&
      role !== "investor"
    ) {
      return redirectTo("/dashboard");
    }
  }

  return response;
}
