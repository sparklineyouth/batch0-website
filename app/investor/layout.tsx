import { requireInvestor } from "@/lib/auth";
import { RoleSidebar } from "@/components/role-sidebar";
import { MobileNav } from "@/components/mobile-nav";
import { getThemeFromCookie } from "@/lib/theme";

export default async function InvestorLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const profile = await requireInvestor();
  const themeClass =
    getThemeFromCookie() === "light" ? "theme-light" : "";
  return (
    <div
      className={`${themeClass} flex min-h-screen bg-black text-white md:flex-row flex-col`}
    >
      <RoleSidebar kind="investor" role={profile.role} />
      <div className="flex flex-1 flex-col">
        <MobileNav kind="investor" role={profile.role} />
        <main className="flex-1 px-5 py-6 md:px-10 md:py-10">{children}</main>
      </div>
    </div>
  );
}
