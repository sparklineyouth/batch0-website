import { requireStaff } from "@/lib/auth";
import { ProfessorSidebar } from "@/components/professor/sidebar";

export default async function ProfessorLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const profile = await requireStaff();
  return (
    <div className="flex min-h-screen bg-black text-white">
      <ProfessorSidebar role={profile.role} />
      <main className="flex-1 px-6 py-8 md:px-10 md:py-10">{children}</main>
    </div>
  );
}
