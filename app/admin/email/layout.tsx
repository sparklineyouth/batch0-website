import { requireAdminArea } from "@/lib/auth";
import { EmailTabs } from "@/components/admin/email-tabs";

/**
 * Wraps every /admin/email page with the section's tab bar.
 *
 * Purely presentational — the per-route permission gate is the admin layout's
 * job (it reads `x-pathname` and checks ADMIN_ROUTE_PERMISSIONS), and the
 * middleware applies the same predicate before that. This only decides which
 * tabs to draw.
 */
export default async function EmailLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { caps } = await requireAdminArea();
  return (
    <div>
      <EmailTabs caps={caps} />
      {children}
    </div>
  );
}
