import { requireStaff } from "@/lib/auth";
import { ProfessorSidebar } from "@/components/professor/sidebar";
import { MobileNav } from "@/components/mobile-nav";
import { PROFESSOR_NAV, STAFF_LINKS } from "@/lib/nav-config";

export default async function ProfessorLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const profile = await requireStaff();
  const extras = profile.role === "admin" ? [STAFF_LINKS.admin] : [];
  return (
    <div className="flex min-h-screen bg-black text-white md:flex-row flex-col">
      <ProfessorSidebar role={profile.role} />
      <div className="flex flex-1 flex-col">
        <MobileNav label="Professor" items={PROFESSOR_NAV} extras={extras} />
        <main className="flex-1 px-5 py-6 md:px-10 md:py-10">{children}</main>
      </div>
    </div>
  );
}
