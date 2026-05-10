import { redirect } from "next/navigation";
import { getProfile } from "@/lib/auth";
import { StudentSidebar } from "@/components/dashboard/sidebar";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const profile = await getProfile();

  // Middleware already gates /dashboard for unauthenticated users.
  // getProfile() self-heals a missing profile row and falls back to a
  // synthesized profile if the DB is unreachable, so this is mostly
  // defensive — it should never hit.
  if (!profile) redirect("/login");

  return (
    <div className="flex min-h-screen bg-black text-white">
      <StudentSidebar role={profile.role} />
      <main className="flex-1 px-6 py-8 md:px-10 md:py-10">{children}</main>
    </div>
  );
}
