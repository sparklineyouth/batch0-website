import { redirect } from "next/navigation";
import { requireAdminPath } from "@/lib/auth";
import { canMeet } from "@/lib/permissions";
import { EMAIL_TABS } from "@/lib/nav-config";

/** The sidebar's Email row lands here: forward to the first tab the viewer holds. */
export default async function EmailLanding() {
  const { caps } = await requireAdminPath("/admin/email");
  const first = EMAIL_TABS.find((t) => canMeet(caps, t.perm));
  redirect(first?.href ?? "/admin");
}
