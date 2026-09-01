import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { requireAdminArea } from "@/lib/auth";
import { canViewAdminPath } from "@/lib/permissions";
import { isInApp, APP_MARK_COOKIE } from "@/lib/app-host";
import { AdminSidebar } from "@/components/admin/sidebar";
import { MobileNav } from "@/components/mobile-nav";

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { profile, caps } = await requireAdminArea();

  // Per-route permission gate, enforced once here rather than repeated in
  // ~50 page files. `x-pathname` is stamped by the middleware (which applies
  // the same predicate before we ever get here); this is the server-side
  // backstop for anything that reaches a page without passing middleware —
  // a server-side redirect, a rewrite, or a route the matcher misses.
  const h = headers();
  const path = h.get("x-pathname") ?? "/admin";
  if (!canViewAdminPath(caps, path)) {
    redirect("/admin");
  }

  // Is this render happening inside the installed app?
  //
  // The app links out here from its More screens, and because the manifest's
  // scope is "/" those links stay in the app window rather than opening a
  // browser (that is deliberate — see app/manifest.webmanifest/route.ts). So
  // for the length of the detour, THIS page is the app: on a 390px screen,
  // showing the full desktop panel means a black-on-white product switch and a
  // sidebar that is `hidden md:flex` and therefore not there at all. Contained,
  // it renders as a plain page in the app's own palette with one way back.
  //
  // Two signals because the app has two front doors. `isAppHost` covers
  // app.batch0.org; the `b0_app` cookie — stamped on every /app request by
  // lib/supabase/middleware.ts — covers everyone who installed from
  // batch0.org/app, where the Host header is indistinguishable from a desktop
  // browser's.
  const inApp =
    isInApp(h.get("host"), cookies().get(APP_MARK_COOKIE)?.value);

  return (
    <div
      className={`flex min-h-screen md:flex-row flex-col ${
        // bg-black/text-white are raw Tailwind, not tokens, and they are what
        // makes the admin panel read as a different product mid-session. The
        // contained branch uses the same tokens as every app screen.
        inApp ? "bg-paper text-ink" : "bg-black text-white"
      }`}
    >
      {/* Suppressed in the app: it is `hidden md:flex`, so on the phone it
          contributes nothing but a mounted NotificationBell, and at desktop
          width inside the app window it would put the full panel navigation
          back on a page the person is only visiting. MobileNav's contained
          bar renders at every width to cover that case. */}
      {!inApp && <AdminSidebar caps={caps} />}
      <div className="flex flex-1 flex-col">
        <MobileNav kind="admin" role={profile.role} caps={caps} inApp={inApp} />
        {/* Target of the root layout's "Skip to content" link — it has to be
            the <main> that follows the sidebar, not anything wrapping it.
            tabIndex={-1} is required: a <main> isn't focusable on its own and
            some screen readers won't move the cursor without it. */}
        <main
          id="main-content"
          tabIndex={-1}
          className="flex-1 px-5 py-6 md:px-10 md:py-10"
        >
          {children}
        </main>
      </div>
    </div>
  );
}
