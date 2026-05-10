import { requireAdmin } from "@/lib/auth";
import { AdminSidebar } from "@/components/admin/sidebar";

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requireAdmin();
  return (
    <div className="flex min-h-screen bg-black text-white">
      <AdminSidebar />
      <main className="flex-1 px-6 py-8 md:px-10 md:py-10">{children}</main>
    </div>
  );
}
