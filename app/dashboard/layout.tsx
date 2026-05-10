import { redirect } from "next/navigation";
import { getProfile } from "@/lib/auth";
import { canUseAi } from "@/lib/access";
import { StudentSidebar } from "@/components/dashboard/sidebar";
import { MobileNav } from "@/components/mobile-nav";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const profile = await getProfile();
  if (!profile) redirect("/login");

  const aiAccess = await canUseAi(profile.role);

  return (
    <div className="flex min-h-screen bg-black text-white md:flex-row flex-col">
      <StudentSidebar role={profile.role} aiAccess={aiAccess} />
      <div className="flex flex-1 flex-col">
        <MobileNav kind="student" role={profile.role} aiAccess={aiAccess} />
        <main className="flex-1 px-5 py-6 md:px-10 md:py-10">{children}</main>
      </div>
    </div>
  );
}
