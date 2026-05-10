import { requireMentor } from "@/lib/auth";
import { RoleSidebar } from "@/components/role-sidebar";
import { MobileNav } from "@/components/mobile-nav";
import { MENTOR_NAV, STAFF_LINKS } from "@/lib/nav-config";

export default async function MentorLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const profile = await requireMentor();
  const extras = profile.role === "admin" ? [STAFF_LINKS.admin] : [];
  return (
    <div className="flex min-h-screen bg-black text-white md:flex-row flex-col">
      <RoleSidebar label="Mentor" role={profile.role} items={MENTOR_NAV} />
      <div className="flex flex-1 flex-col">
        <MobileNav label="Mentor" items={MENTOR_NAV} extras={extras} />
        <main className="flex-1 px-5 py-6 md:px-10 md:py-10">{children}</main>
      </div>
    </div>
  );
}
