import { redirect } from "next/navigation";
import { requireAdminPath } from "@/lib/auth";
import { smsLandingFor } from "@/lib/permissions";

/**
 * The sidebar's Texting row. The middleware forwards it to the first tab the
 * viewer holds; this is the backstop for a request that skipped middleware.
 */
export default async function SmsLanding() {
  const { caps } = await requireAdminPath("/admin/sms");
  redirect(smsLandingFor(caps) ?? "/admin");
}
