import { requireAdmin } from "@/lib/auth";
import { AdminSidebar } from "@/components/admin/sidebar";
import { MobileNav } from "@/components/mobile-nav";
import { getThemeFromCookie } from "@/lib/theme";

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const profile = await requireAdmin();

  const themeClass =
    getThemeFromCookie() === "light" ? "theme-light" : "";
  return (
    <div
      className={`${themeClass} flex min-h-screen bg-black text-white md:flex-row flex-col`}
    >
      <AdminSidebar />
      <div className="flex flex-1 flex-col">
        <MobileNav kind="admin" role={profile.role} />
        <main className="flex-1 px-5 py-6 md:px-10 md:py-10">{children}</main>
      </div>
    </div>
  );
}
