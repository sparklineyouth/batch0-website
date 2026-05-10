import { requireAdmin } from "@/lib/auth";
import { AdminSidebar } from "@/components/admin/sidebar";
import { MobileNav } from "@/components/mobile-nav";
import { ADMIN_NAV } from "@/lib/nav-config";

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requireAdmin();
  return (
    <div className="flex min-h-screen bg-black text-white md:flex-row flex-col">
      <AdminSidebar />
      <div className="flex flex-1 flex-col">
        <MobileNav label="Admin" items={ADMIN_NAV} />
        <main className="flex-1 px-5 py-6 md:px-10 md:py-10">{children}</main>
      </div>
    </div>
  );
}
