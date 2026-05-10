import { requireInvestor } from "@/lib/auth";
import { RoleSidebar } from "@/components/role-sidebar";
import { MobileNav } from "@/components/mobile-nav";
import { INVESTOR_NAV, STAFF_LINKS } from "@/lib/nav-config";

export default async function InvestorLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const profile = await requireInvestor();
  const extras = profile.role === "admin" ? [STAFF_LINKS.admin] : [];
  return (
    <div className="flex min-h-screen bg-black text-white md:flex-row flex-col">
      <RoleSidebar label="Investor" role={profile.role} items={INVESTOR_NAV} />
      <div className="flex flex-1 flex-col">
        <MobileNav label="Investor" items={INVESTOR_NAV} extras={extras} />
        <main className="flex-1 px-5 py-6 md:px-10 md:py-10">{children}</main>
      </div>
    </div>
  );
}
