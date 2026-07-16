import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import {
  isPreCohortAllowedPath,
  computePreCohort,
  isAcceptedStatus,
  type PreCohortCohort,
} from "@/lib/pre-cohort";

type CookiesToSet = {
  name: string;
  value: string;
  options: CookieOptions;
}[];

// Mirrored from lib/auth.ts:roleHome — kept inline so middleware doesn't
// pull in lib/auth.ts (which transitively imports next/headers + the
// admin/service-role client and isn't Edge-safe).
type RoleLike = "student" | "admin" | "mentor" | "investor" | string | null | undefined;
function roleHome(role: RoleLike): string {
  switch (role) {
    case "admin":
      return "/admin";
    case "mentor":
      return "/mentor";
    case "investor":
      return "/investor";
    default:
      return "/dashboard";
  }
}

export async function updateSession(request: NextRequest) {
  // Stamp the request pathname onto a header so downstream server
  // components (admin layout, page-level guards) can read it via
  // next/headers without parsing the URL on their own. Next.js doesn't
  // expose pathname to RSC by default.
  const reqHeaders = new Headers(request.headers);
  reqHeaders.set("x-pathname", request.nextUrl.pathname);
  let response = NextResponse.next({ request: { headers: reqHeaders } });

  // Middleware reads per-user state (role, pending fines, etc.) on every
  // request. Next.js otherwise caches GET fetches inside middleware,
  // which makes a freshly-changed `profiles.role` look stale until the
  // user signs back in. Force every Supabase fetch to bypass cache.
  const noStoreFetch: typeof fetch = (input, init) =>
    fetch(input, { ...init, cache: "no-store" });

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
          // Re-issue the response with our augmented headers — passing the
          // bare `request` here would lose the x-pathname header we just
          // set above.
          response = NextResponse.next({ request: { headers: reqHeaders } });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
        },
      },
      global: { fetch: noStoreFetch },
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
    path.startsWith("/notifications") ||
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
    // /apply is the marketing funnel entry — most unauth visitors here are
    // brand-new and need an account first. Route them to /signup. All other
    // protected routes (admin/dashboard/mentor/investor) are returning-user
    // surfaces, so keep /login as the default.
    const dest = path === "/apply" || path.startsWith("/apply/") ? "/signup" : "/login";
    // Preserve the full path INCLUDING query (e.g. `?ref=CODE`) so a referral
    // code survives the auth bounce — otherwise a logged-out referred visitor
    // loses their referrer on the way through signup.
    return redirectTo(
      dest,
      `?next=${encodeURIComponent(path + request.nextUrl.search)}`,
    );
  }

  if (authPath && user) {
    // Send signed-in users to their role home rather than always /dashboard,
    // since /dashboard is now student-only and would otherwise bounce again.
    const { data: profile } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .maybeSingle();
    return redirectTo(roleHome(profile?.role));
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
    (path.startsWith("/dashboard") ||
      path.startsWith("/admin") ||
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
    // /dashboard is the student area. Mentors and investors get bounced
    // to their own panel — they have no business in the student view.
    // Admins are allowed through as an opt-in (the admin sidebar has a
    // "Student view" link), but their default home stays /admin.
    // Billing + pay-fine are shared per-user views every role can reach.
    if (
      path.startsWith("/dashboard") &&
      !path.startsWith("/dashboard/pay-fine") &&
      !path.startsWith("/dashboard/billing") &&
      role !== "student" &&
      role !== "admin"
    ) {
      return redirectTo(roleHome(role));
    }
    if (path.startsWith("/admin") && role !== "admin") {
      return redirectTo(roleHome(role));
    }
    if (
      path.startsWith("/mentor") &&
      role !== "admin" &&
      role !== "mentor"
    ) {
      return redirectTo(roleHome(role));
    }
    if (
      path.startsWith("/investor") &&
      role !== "admin" &&
      role !== "investor"
    ) {
      return redirectTo(roleHome(role));
    }

    // Pre-cohort lockdown: an accepted (or already-enrolled) student whose
    // cohort hasn't started yet can only load the personal pages — home,
    // application, resources, billing, referrals, settings (+ pay-fine).
    // Every other /dashboard route bounces home. The sidebar hides the
    // links too; this is the hard server-side gate, so a typed URL, a
    // stale link, or a prefetch can't reach past the designated pages.
    // Decision logic is shared with lib/access.ts via lib/pre-cohort.ts.
    if (
      path.startsWith("/dashboard") &&
      role !== "admin" &&
      !isPreCohortAllowedPath(path)
    ) {
      // Two parallel queries; the cohort rows ride along as embeds. On any
      // query error, fail open — a transient DB blip must not lock a
      // mid-cohort student out of the course (the page-level guards still
      // hold the enrollment line).
      const [appsRes, enrollsRes] = await Promise.all([
        supabase
          .from("applications")
          .select("status, cohort_id, cohort:cohorts(starts_on, status)")
          .eq("user_id", user.id)
          .order("created_at", { ascending: false })
          .limit(1),
        supabase
          .from("enrollments")
          .select("cohort_id, cohort:cohorts(starts_on, status)")
          .eq("user_id", user.id),
      ]);
      if (!appsRes.error && !enrollsRes.error) {
        const app = appsRes.data?.[0] ?? null;
        const accepted = !!app && isAcceptedStatus(app.status);
        const enrollRows = enrollsRes.data ?? [];
        if (accepted || enrollRows.length > 0) {
          const seen = new Set<string>();
          const cohorts: PreCohortCohort[] = [];
          const rows = accepted && app ? [...enrollRows, app] : enrollRows;
          for (const row of rows) {
            const c = Array.isArray(row.cohort) ? row.cohort[0] : row.cohort;
            if (row.cohort_id && c && !seen.has(row.cohort_id)) {
              seen.add(row.cohort_id);
              cohorts.push(c);
            }
          }
          if (computePreCohort(true, cohorts)) {
            return redirectTo("/dashboard");
          }
        }
      }
    }
  }

  return response;
}
