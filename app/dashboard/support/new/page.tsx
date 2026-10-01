import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requireViewer } from "@/lib/auth";
import { getSiteConfig } from "@/lib/site-config";
import { NewRequest, type SupportPrefillParams } from "@/components/support/new-request";

export const metadata = { title: "New request · batch0" };
export const dynamic = "force-dynamic";

/**
 * The request form inside the dashboard — the same form /support shows, with
 * the same prefill rules (components/support/new-request.tsx), so "New
 * request" from the list and the links in the requester's own notifications
 * keep the person in the shell they were already in. No enrolment gate, and
 * reachable by every role and through a pending fine (lib/dashboard-gate.ts,
 * lib/supabase/middleware.ts): anyone signed in may ask for help.
 */
export default async function NewSupportRequestPage(props: {
  searchParams: Promise<SupportPrefillParams>;
}) {
  const [searchParams, { profile }, config] = await Promise.all([
    props.searchParams,
    requireViewer(),
    getSiteConfig(),
  ]);

  return (
    <div className="mx-auto max-w-2xl pb-16">
      <Link
        href="/dashboard/support"
        prefetch={false}
        className="inline-flex items-center gap-1.5 text-xs text-ink-soft hover:text-ink"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Help &amp; support
      </Link>
      <h1 className="mt-4 text-3xl font-bold tracking-tight">New request</h1>
      <p className="mt-1 text-sm text-ink-soft">
        Goes to the batch0 team. Every request gets a reference, a recorded
        time, and a reply from a person.
      </p>

      <div className="mt-8">
        <NewRequest
          email={profile.email ?? ""}
          params={searchParams}
          contactEmail={config.settings.contactEmail}
        />
      </div>
    </div>
  );
}
