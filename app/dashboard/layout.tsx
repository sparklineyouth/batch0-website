import { redirect } from "next/navigation";
import { getProfile } from "@/lib/auth";
import { StudentSidebar } from "@/components/dashboard/sidebar";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const profile = await getProfile();
  if (!profile) redirect("/login?next=/dashboard");

  return (
    <div className="flex min-h-screen bg-black text-white">
      <StudentSidebar isAdmin={profile.role === "admin" || profile.role === "teacher"} />
      <main className="flex-1 px-6 py-8 md:px-10 md:py-10">{children}</main>
    </div>
  );
}
