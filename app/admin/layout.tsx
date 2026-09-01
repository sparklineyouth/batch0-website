import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { requireAdminArea } from "@/lib/auth";
import { canViewAdminPath } from "@/lib/permissions";
import { AdminSidebar } from "@/components/admin/sidebar";
import { MobileNav } from "@/components/mobile-nav";

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { profile, caps } = await requireAdminArea();

  // Per-route permission gate, enforced once here rather than repeated in
  // ~50 page files. `x-pathname` is stamped by the middleware (which applies
  // the same predicate before we ever get here); this is the server-side
  // backstop for anything that reaches a page without passing middleware —
  // a server-side redirect, a rewrite, or a route the matcher misses.
  const path = headers().get("x-pathname") ?? "/admin";
  if (!canViewAdminPath(caps, path)) {
    redirect("/admin");
  }

  return (
    <div
      className="flex min-h-screen bg-black text-white md:flex-row flex-col"
    >
      <AdminSidebar caps={caps} />
      <div className="flex flex-1 flex-col">
        <MobileNav kind="admin" role={profile.role} caps={caps} />
        {/* Target of the root layout's "Skip to content" link — it has to be
            the <main> that follows the sidebar, not anything wrapping it.
            tabIndex={-1} is required: a <main> isn't focusable on its own and
            some screen readers won't move the cursor without it. */}
        <main
          id="main-content"
          tabIndex={-1}
          className="flex-1 px-5 py-6 md:px-10 md:py-10"
        >
          {children}
        </main>
      </div>
    </div>
  );
}
