import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import {
  isPreCohortAllowedPath,
  computePreCohort,
  isAcceptedStatus,
  type PreCohortCohort,
} from "@/lib/pre-cohort";
import {
  can,
  canAccessAdmin,
  canViewAdminPath,
  capabilitiesFrom,
  resolveHome,
  type Capabilities,
} from "@/lib/permissions";
import { isAppHost, isMarketingPath, MAIN_ORIGIN } from "@/lib/app-host";

type CookiesToSet = {
  name: string;
  value: string;
  options: CookieOptions;
}[];

/**
 * Permissions for the four system roles, without a database round trip.
 *
 * Only used when `app_roles` can't be read — migration 0048 not applied yet,
 * or a transient failure. Mirrors the seed in that migration and the fallback
 * in lib/roles.ts, so an un-migrated deploy gates exactly as it did before
 * roles became data rather than locking everyone out.
 */
const FALLBACK_PERMISSIONS: Record<string, string[]> = {
  student: ["student.dashboard"],
  admin: ["*"],
  mentor: ["mentor.panel"],
  investor: ["investor.panel"],
};

/**
 * This project's session cookie, as @supabase/ssr writes it:
 * `sb-<projectRef>-auth-token`, split into `.0` / `.1` when it outgrows the
 * cookie size limit.
 *
 * Scoped to THIS project's ref rather than a loose `sb-.+-auth-token`. A
 * visitor can be carrying a leftover cookie from a preview deployment wired to
 * a different Supabase project; matching that would classify a genuinely new
 * person as "already has an account" and route them to /login instead of
 * /signup — a dead end at the top of the signup funnel. Falls back to the
 * loose pattern only if the URL is somehow unparseable.
 */
const PROJECT_REF = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").match(
  /^https?:\/\/([a-z0-9]+)\./i,
)?.[1];
const AUTH_COOKIE = new RegExp(
  `^sb-${PROJECT_REF ?? "[a-z0-9]+"}-auth-token(\\.\\d+)?$`,
);

const FALLBACK_HOME: Record<string, string> = {
  student: "/dashboard",
  admin: "/admin",
  mentor: "/mentor",
  investor: "/investor",
};

/**
 * Paths that are fully prerendered and read no session at all.
 *
 * Vercel runs middleware BEFORE the CDN cache lookup, so even a static HTML
 * hit pays for whatever happens in here. Since these routes stopped touching
 * cookies (that is what let them prerender), constructing a Supabase client
 * and validating a JWT for them is pure overhead on the site's highest-volume
 * traffic — the homepage, /program, 135 blog articles, plus the legal pages.
 * The marketing navbar's signed-in state on these pages is a client cookie
 * island, so middleware has no auth-dependent behavior on any of them.
 *
 * "/" is safe as a member because matching is exact-or-"prefix/": only the
 * literal "/" hits the exact branch, and no other path starts with "//".
 *
 * Everything else keeps going through updateSession, because that is what
 * refreshes an expiring access token; a route that reads the session and is
 * missing from the middleware would silently show a signed-in user as signed
 * out. Only add a path here once it genuinely reads no auth.
 */
const PUBLIC_STATIC_PREFIXES = [
  "/",
  "/program",
  "/blog",
  "/privacy",
  "/terms",
  "/refund-policy",
  "/sponsors",
  // The service worker's offline fallback. It is precached at install time and
  // served from the device with no network, so it reads nothing about the
  // viewer by construction — running session work for it would only slow down
  // the one request that happens while the connection is still fine.
  "/offline",
];

/**
 * Exact-only members: the path itself is prerendered but paths beneath it
 * are not. /challenges/[slug] is force-dynamic and reads the session (the
 * entry form vs. sign-in CTA), so it must keep flowing through
 * updateSession — a prefix entry would skip it and an expiring token would
 * never refresh on those pages.
 */
const PUBLIC_STATIC_EXACT = new Set<string>(["/challenges"]);

function isPublicStatic(path: string): boolean {
  return (
    PUBLIC_STATIC_EXACT.has(path) ||
    PUBLIC_STATIC_PREFIXES.some((p) => path === p || path.startsWith(p + "/"))
  );
}

/**
 * The installable app surface (app/app/**), matched exactly.
 *
 * Deliberately not `startsWith("/app")`: "/apply" starts with "/app" too, and
 * "/apply" is the marketing funnel with its own signup-vs-login routing and its
 * own place in the pending-fine gate. Conflating them is a one-character bug
 * with a very confusing symptom.
 */
function isAppPath(path: string): boolean {
  return path === "/app" || path.startsWith("/app/");
}

export async function updateSession(request: NextRequest) {
  // ---- App subdomain routing -------------------------------------------
  //
  // Runs before everything, including the public-static shortcut, because both
  // rules below concern paths that shortcut would otherwise wave through.
  //
  // Deliberately two redirects rather than a rewrite. A rewrite would have to
  // thread a mutated pathname through the whole session pipeline below —
  // including the two places that re-issue `response` after a token refresh —
  // and this is the one file where a mistake logs every user out. The cost of
  // the redirect is one hop on the bare domain, which the installed app never
  // pays: the manifest points start_url straight at /app.
  const host = request.headers.get("host");
  if (isAppHost(host)) {
    // The subdomain IS the app, so its root is the app's root.
    if (request.nextUrl.pathname === "/") {
      const url = request.nextUrl.clone();
      url.pathname = "/app";
      return NextResponse.redirect(url);
    }
    // Public pages belong to the apex. Serving them here too would put a second
    // indexable copy of 135 blog posts on a subdomain that exists to be a
    // private tool.
    if (isMarketingPath(request.nextUrl.pathname)) {
      return NextResponse.redirect(
        `${MAIN_ORIGIN}${request.nextUrl.pathname}${request.nextUrl.search}`,
      );
    }
  }

  if (isPublicStatic(request.nextUrl.pathname)) {
    return NextResponse.next();
  }

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

  // Snapshot the incoming auth cookies BEFORE the client exists.
  //
  // This has to happen here, not later: setAll() below writes refreshed
  // cookies back onto `request.cookies` as well as the response, so once a
  // token refresh has run, the "incoming" jar no longer describes what the
  // browser actually sent — it describes what we are about to send back.
  // Deciding "was this visitor carrying a dead cookie?" from the mutated jar
  // would mean judging a token the auth library had just minted.
  const incomingAuthCookies = request.cookies
    .getAll()
    .filter((c) => AUTH_COOKIE.test(c.name))
    .map((c) => c.name);
  const hadAuthCookie = incomingAuthCookies.length > 0;

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

  // IMPORTANT: do not put logic between createServerClient and the auth call.
  // It also refreshes the session if needed, which writes new cookies onto
  // `response` via setAll above. Any redirect we return must carry those
  // cookies forward or the user will be silently logged out.
  //
  // getClaims(), not getUser(): this project signs JWTs with an asymmetric
  // ES256 key (confirmed live at /auth/v1/.well-known/jwks.json), so getClaims
  // verifies the token locally with WebCrypto against a cached JWKS instead of
  // spending a GoTrue round trip — measured at 176-209ms — on every single
  // authenticated request. The trust level is identical: both verify the
  // signature, unlike getSession(), which trusts the cookie blindly. It still
  // refreshes an access token that is close to expiring, so the cookie
  // plumbing above stays load-bearing.
  //
  // The tradeoff to know about: a locally-verified token is trusted until its
  // `exp` (~1h), so a user deleted or globally signed out mid-session keeps
  // access until then. That is fine for the gates below, which are about
  // *which area* you may see; the pages themselves re-read the database.
  //
  // Wrapped because a *corrupt* cookie throws rather than returning an error:
  // @supabase/ssr base64url-decodes the cookie before any auth logic runs, and
  // a truncated or mangled value raises "Invalid UTF-8 sequence" out of
  // stringFromUTF8. Unhandled, that is a 500 on every route the matcher
  // covers — the whole site down for one bad cookie, with no way for the
  // visitor to recover since they cannot clear it from an error page.
  //
  // The `error` channel matters just as much as the throw. getClaims() does
  // NOT throw for auth failures — it returns { data: null, error }. Collapsing
  // every one of those into "signed out" is wrong, because most of them are
  // transient and have nothing to do with the token being bad:
  //   - the JWKS fetch failing (the key cache is empty on every cold isolate),
  //   - a refresh-token rotation race, which this app causes itself whenever a
  //     page and its prefetches hit the origin together — one wins and the
  //     losers get "Invalid Refresh Token: Already Used",
  //   - any GoTrue 5xx.
  // Treating those as a dead session AND expiring the cookie would take a
  // live, signed-in user and log them out permanently: refresh tokens rotate,
  // so the one in the cookie we just deleted is already spent.
  let claims: Record<string, unknown> | null = null;
  let tokenDefinitelyInvalid = false;
  try {
    const { data: claimsData, error } = await supabase.auth.getClaims();
    if (error) {
      // Only a token the server actively rejected is "definitely invalid".
      // 401/403 mean the JWT itself is bad. Everything else — network,
      // 5xx, refresh races, anything unrecognised — is assumed transient.
      const status = (error as { status?: number }).status;
      tokenDefinitelyInvalid = status === 401 || status === 403;
      console.error(
        `[middleware] getClaims failed on ${request.nextUrl.pathname}:`,
        status ?? "(no status)",
        error.message,
      );
    } else {
      claims = (claimsData?.claims as Record<string, unknown>) ?? null;
    }
  } catch (err) {
    // A decode throw happens before any network call or refresh, so nothing
    // can have raced us — the cookie really is garbage.
    tokenDefinitelyInvalid = true;
    console.error("[middleware] auth cookie could not be decoded:", err);
  }
  // Every gate below needs only the id and truthiness.
  const user = claims ? { id: claims.sub as string } : null;

  const path = request.nextUrl.pathname;
  // Did the auth library mint a new session while we were in here? If so, the
  // cookie on the response is fresh by definition and must never be expired,
  // whatever the verification outcome was.
  const refreshedThisRequest = response.cookies
    .getAll()
    .some((c) => AUTH_COOKIE.test(c.name) && !!c.value);
  // A cookie worth expiring: the visitor sent one, the server said it is
  // invalid rather than merely unverifiable, and we did not just replace it.
  // Clearing it is what stops the marketing navbar and hero from advertising
  // "Go to dashboard" forever (components/auth-label.tsx tests cookie
  // presence, not validity). Being conservative here costs only that cosmetic
  // correction; being wrong costs the user their session.
  const staleAuthCookie =
    !user && hadAuthCookie && tokenDefinitelyInvalid && !refreshedThisRequest;
  const protectedPath =
    path.startsWith("/dashboard") ||
    path.startsWith("/admin") ||
    path.startsWith("/mentor") ||
    path.startsWith("/investor") ||
    path.startsWith("/notifications") ||
    // The installable app (app/app/**). Every route under it is authenticated;
    // the per-side permission gates live in its layouts, the same way /dashboard
    // and /admin work. It has to be listed here so a signed-out tap on the home
    // screen icon lands on /login with ?next=/app instead of rendering a shell
    // that redirects a beat later.
    //
    // Exact-or-"/app/" rather than a bare startsWith: "/apply" also starts with
    // "/app", and collapsing the two would quietly hand the application funnel
    // the app's gating.
    isAppPath(path) ||
    path.startsWith("/apply");
  const authPath = path === "/login" || path === "/signup";

  function redirectTo(pathname: string, search?: string) {
    const url = request.nextUrl.clone();
    url.pathname = pathname;
    url.search = search ?? "";
    const redirect = NextResponse.redirect(url);
    // Carry over any auth cookies that the auth call may have refreshed,
    // otherwise the session is dropped on every redirect.
    response.cookies.getAll().forEach((c) => {
      redirect.cookies.set(c.name, c.value, c);
    });
    // A token the server actively rejected is never coming back — expire it
    // so the client-side auth label stops claiming the visitor is signed in.
    // Iterates the SNAPSHOT taken before the client was built, not the live
    // request jar: setAll() writes refreshed cookies into that jar, so reading
    // it here could delete a token minted moments ago. `staleAuthCookie`
    // already excludes that case; this makes it structurally impossible.
    // Runs after the copy above so it wins on name collision.
    if (staleAuthCookie) {
      incomingAuthCookies.forEach((name) => {
        redirect.cookies.set(name, "", { path: "/", maxAge: 0 });
      });
    }
    return redirect;
  }

  // "/home" — "take me where I belong". app/home/route.ts answers this by
  // re-resolving the profile and role from scratch, which is an entire extra
  // origin document plus four serial network hops. Middleware is already here,
  // has already verified the JWT, and resolves `home` below from the same
  // parallel batch it runs anyway — so answer it here and the hop disappears.
  // The route handler stays as the fallback for requests that skip middleware
  // (and as the only place that self-heals a missing profiles row).
  const homePath = path === "/home";
  if (homePath && !user) {
    // Skip the /apply bounce: unauthenticated /apply would immediately
    // redirect again, so go straight to the end of that chain. Routing keys
    // off cookie PRESENCE, not the stricter deletion signal — someone whose
    // token merely failed to verify transiently still has an account, and
    // /login is the right door for them either way.
    return redirectTo(hadAuthCookie ? "/login" : "/signup", "?next=%2Fapply");
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
    // ...unless they arrived carrying a session cookie. That person has an
    // account and needs to sign back in, not create a second one.
    const dest =
      !hadAuthCookie && (path === "/apply" || path.startsWith("/apply/"))
        ? "/signup"
        : "/login";
    // Preserve the full path INCLUDING query (e.g. `?ref=CODE`) so a referral
    // code survives the auth bounce — otherwise a logged-out referred visitor
    // loses their referrer on the way through signup.
    return redirectTo(
      dest,
      `?next=${encodeURIComponent(path + request.nextUrl.search)}`,
    );
  }

  if (user) {
    // Which gates apply to a request is decidable from the path alone, so
    // everything they read is fetched as ONE parallel batch. Middleware runs
    // at the edge PoP nearest the visitor while the database sits in a
    // single region, making every sequential query a full cross-region
    // round trip — nothing below may chain a read behind another read.
    // Lookups a path can't use stay null and cost nothing.
    const sectionPath =
      path.startsWith("/dashboard") ||
      path.startsWith("/admin") ||
      path.startsWith("/mentor") ||
      path.startsWith("/investor");
    // Paths covered by the pending-fine hard-block below. Billing, pay-fine
    // and /auth stay exempt so a fined user can still reach the pay screen
    // and sign out.
    const finePath =
      (path.startsWith("/dashboard") ||
        path.startsWith("/apply") ||
        // The app is behind the fine gate too. Leaving it out would have made
        // the home-screen icon a way around a hard block that exists precisely
        // because it cannot be walked around — the fined student would simply
        // use the app instead of the site.
        isAppPath(path) ||
        path.startsWith("/mentor") ||
        path.startsWith("/investor")) &&
      !path.startsWith("/dashboard/billing") &&
      !path.startsWith("/dashboard/pay-fine") &&
      !path.startsWith("/auth");
    // Capabilities ride along for fine-only paths (i.e. /apply) too: the
    // fine block consults caps.superAdmin, and a speculative parallel read
    // beats a serial one in the rare pending-fine case.
    // `/home` joins them: resolving where this visitor belongs needs exactly
    // the same profiles + app_roles pair, and getting it from this one
    // parallel batch is what lets us answer /home here instead of paying for
    // a whole second document that does the identical work serially.
    const needsCaps = authPath || sectionPath || finePath || homePath;
    // Pre-cohort rows are keyed off the path alone. Staff previewing the
    // student view trigger the read as well, but the gate below still checks
    // canAccessAdmin and ignores the rows for them — a harmless extra
    // parallel read instead of serializing behind the capabilities lookup.
    const needsPreCohort =
      path.startsWith("/dashboard") && !isPreCohortAllowedPath(path);

    const [fineRes, profileRes, rolesRes, appsRes, enrollsRes] =
      await Promise.all([
        finePath
          ? supabase
              .from("user_charges")
              .select("id")
              .eq("user_id", user.id)
              .eq("kind", "fine")
              .eq("status", "pending")
              .limit(1)
              .maybeSingle()
          : null,
        needsCaps
          ? supabase
              .from("profiles")
              .select("role")
              .eq("id", user.id)
              .maybeSingle()
          : null,
        // The whole app_roles table (a handful of rows) rather than the one
        // row for this user's slug — a slug-filtered read would have to
        // wait on profiles.role and re-serialize the batch. The row is
        // picked in JS below.
        needsCaps
          ? supabase.from("app_roles").select("slug, permissions, home_path")
          : null,
        // The cohort rows ride along as embeds; decision logic is shared
        // with lib/access.ts via lib/pre-cohort.ts.
        needsPreCohort
          ? supabase
              .from("applications")
              .select("status, cohort_id, cohort:cohorts(starts_on, status)")
              .eq("user_id", user.id)
              .order("created_at", { ascending: false })
              .limit(1)
          : null,
        needsPreCohort
          ? supabase
              .from("enrollments")
              .select("cohort_id, cohort:cohorts(starts_on, status)")
              .eq("user_id", user.id)
          : null,
      ]);

    // Role + permissions for the signed-in user, resolved once and reused by
    // every gate below. Roles are data since migration 0048, so "what can
    // this person reach" is a permission lookup rather than a slug
    // comparison — that's what lets a custom role like `intern` into part of
    // /admin. When app_roles can't be read or the slug has no row, the
    // FALLBACK_* tables above take over.
    const role = (profileRes?.data?.role as string) ?? "student";
    const roleRow =
      rolesRes && !rolesRes.error
        ? ((rolesRes.data ?? []).find((r: any) => r.slug === role) ?? null)
        : null;
    const caps: Capabilities = roleRow
      ? capabilitiesFrom(role, roleRow.permissions as string[])
      : capabilitiesFrom(role, FALLBACK_PERMISSIONS[role] ?? []);
    const storedHome = roleRow
      ? ((roleRow.home_path as string) ?? null)
      : (FALLBACK_HOME[role] ?? null);
    const home = resolveHome(caps, storedHome);

    // The /home answer, resolved from the batch above rather than from a
    // second document. This is the hero's "Go to dashboard" click: it now
    // costs one redirect out of middleware instead of an origin round trip
    // that re-verified the JWT and re-read profiles + app_roles serially.
    if (homePath) {
      return redirectTo(home);
    }

    if (authPath) {
      // Send signed-in users to their role home rather than always
      // /dashboard, since /dashboard is now participant-only and would
      // otherwise bounce again.
      return redirectTo(home);
    }

    // Hard-block: any signed-in user with a pending fine can only reach the
    // pay-fine screen + billing + signout until it's paid or waived. Full
    // admins bypass so they can still hit /admin to waive.
    if (finePath && fineRes?.data && !caps.superAdmin) {
      return redirectTo("/dashboard/pay-fine");
    }

    if (sectionPath) {
      // /dashboard is the participant area, gated by `student.dashboard`.
      // Mentors and investors get bounced to their own panel — they have no
      // business in the student view. Admins hold the wildcard and are allowed
      // through as an opt-in (the admin sidebar has a "Student view" link), but
      // their default home stays /admin. Billing + pay-fine are shared per-user
      // views every role can reach.
      if (
        path.startsWith("/dashboard") &&
        !path.startsWith("/dashboard/pay-fine") &&
        !path.startsWith("/dashboard/billing") &&
        !can(caps, "student.dashboard") &&
        // Never bounce /dashboard at /dashboard. A role with no permissions at
        // all resolves its home to /dashboard, and redirecting there would spin
        // forever; the dashboard layout renders bare chrome for these viewers
        // instead, which is a dead end rather than a loop.
        home !== "/dashboard"
      ) {
        return redirectTo(home);
      }
      // /admin is permission-gated per route: `canViewAdminPath` first checks
      // the person belongs in the admin area at all, then that they hold the
      // specific permission that route needs (see ADMIN_ROUTE_PERMISSIONS).
      // The admin layout re-checks the same predicate server-side.
      if (path.startsWith("/admin") && !canViewAdminPath(caps, path)) {
        // Someone who belongs in /admin but not on this page lands on the
        // overview, which they can always read — bouncing them out of the
        // panel entirely would be a dead end.
        return redirectTo(canAccessAdmin(caps) ? "/admin" : home);
      }
      if (path.startsWith("/mentor") && !can(caps, "mentor.panel")) {
        return redirectTo(home);
      }
      if (path.startsWith("/investor") && !can(caps, "investor.panel")) {
        return redirectTo(home);
      }

      // Pre-cohort lockdown: an accepted (or already-enrolled) student whose
      // cohort hasn't started yet can only load the personal pages — home,
      // application, resources, billing, referrals, settings (+ pay-fine).
      // Every other /dashboard route bounces home. The sidebar hides the
      // links too; this is the hard server-side gate, so a typed URL, a
      // stale link, or a prefetch can't reach past the designated pages.
      // Staff previewing the student view are exempt.
      if (
        path.startsWith("/dashboard") &&
        !canAccessAdmin(caps) &&
        !isPreCohortAllowedPath(path)
      ) {
        // On any query error, fail open — a transient DB blip must not lock
        // a mid-cohort student out of the course (the page-level guards
        // still hold the enrollment line).
        if (appsRes && enrollsRes && !appsRes.error && !enrollsRes.error) {
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
  }

  return response;
}
