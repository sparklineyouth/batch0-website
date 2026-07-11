import { requireAdmin } from "@/lib/auth";
import { AdminSidebar } from "@/components/admin/sidebar";
import { MobileNav } from "@/components/mobile-nav";

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const profile = await requireAdmin();

  // Theme is driven site-wide by next-themes on <html> (see ThemeProvider);
  // the light compat layer in globals.css flips these dark utilities when the
  // global theme is light.
  return (
    <div
      className="flex min-h-screen bg-black text-white md:flex-row flex-col"
    >
      <AdminSidebar />
      <div className="flex flex-1 flex-col">
        <MobileNav kind="admin" role={profile.role} />
        <main className="flex-1 px-5 py-6 md:px-10 md:py-10">{children}</main>
      </div>
    </div>
  );
}
