import { redirect } from "next/navigation";
import { requireAdminPath } from "@/lib/auth";
import { emailLandingFor } from "@/lib/permissions";

/**
 * The sidebar's Email row. The middleware forwards it to the first tab the
 * viewer holds; this is the backstop for a request that skipped middleware.
 */
export default async function EmailLanding() {
  const { caps } = await requireAdminPath("/admin/email");
  redirect(emailLandingFor(caps) ?? "/admin");
}
