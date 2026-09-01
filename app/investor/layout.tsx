import { requireInvestor, getCapabilities } from "@/lib/auth";
import { RoleSidebar } from "@/components/role-sidebar";
import { MobileNav } from "@/components/mobile-nav";
import { cookies, headers } from "next/headers";
import { isInApp, APP_MARK_COOKIE } from "@/lib/app-host";

export default async function InvestorLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const profile = await requireInvestor();
  // Request-cached alongside the guard above, so this is not a second read.
  const caps = await getCapabilities();
  // app/app/page.tsx redirects mentors and investors straight here — neither
  // role has a mobile side yet — so this layout is reachable from inside the
  // installed app, where it would otherwise be a one-way door: a standalone
  // window has no back button and nothing on this page points at /app.
  const inApp = isInApp(
    headers().get("host"),
    cookies().get(APP_MARK_COOKIE)?.value,
  );
  // Theme driven site-wide by next-themes on <html> (see ThemeProvider).
  return (
    <div
      className="flex min-h-screen bg-paper text-ink md:flex-row flex-col"
    >
      <RoleSidebar kind="investor" role={profile.role} caps={caps} />
      <div className="flex flex-1 flex-col">
        <MobileNav kind="investor" role={profile.role} caps={caps} inApp={inApp} />
        {/* Skip-link target. tabIndex={-1} makes the non-focusable <main>
            focusable so screen readers actually move the cursor here. */}
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
