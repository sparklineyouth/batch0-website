import { redirect } from "next/navigation";
import { getProfile } from "@/lib/auth";
import { StudentSidebar } from "@/components/dashboard/sidebar";
import { MobileNav } from "@/components/mobile-nav";
import { STUDENT_NAV, STAFF_LINKS } from "@/lib/nav-config";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const profile = await getProfile();
  if (!profile) redirect("/login");

  const extras: { href: string; label: string; icon: any }[] = [];
  if (profile.role === "admin") extras.push(STAFF_LINKS.admin);
  if (profile.role === "admin" || profile.role === "professor")
    extras.push(STAFF_LINKS.professor);
  if (profile.role === "admin" || profile.role === "mentor")
    extras.push(STAFF_LINKS.mentor);
  if (profile.role === "admin" || profile.role === "investor")
    extras.push(STAFF_LINKS.investor);

  return (
    <div className="flex min-h-screen bg-black text-white md:flex-row flex-col">
      <StudentSidebar role={profile.role} />
      <div className="flex flex-1 flex-col">
        <MobileNav items={STUDENT_NAV} extras={extras} />
        <main className="flex-1 px-5 py-6 md:px-10 md:py-10">{children}</main>
      </div>
    </div>
  );
}
