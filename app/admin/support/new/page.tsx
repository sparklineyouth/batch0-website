import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requirePermission } from "@/lib/auth";
import { Card } from "@/components/ui/card";
import { supportInboxAddress } from "@/lib/support";
import {
  REQUESTER_NAME_MAX,
  STAFF_LOG_MAX_AGE_DAYS,
  supportScopeFor,
  toEasternLocalInput,
} from "@/lib/support-access";
import { LogRequestForm } from "./log-request-form";
import { looksLikeEmail } from "./requester-email";

export const metadata = { title: "Log a request · Admin" };
export const dynamic = "force-dynamic";
export const revalidate = 0;

type RawSearchParams = Record<string, string | string[] | undefined>;

/** A repeated param arrives as an array; the first one wins. */
function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Log a request that reached the team some other way — an email to the
 * inbox, a phone call — so it is worked, and counted, like one filed on the
 * site. Email is a co-equal refund channel (a parent often has no account at
 * all), and the refund policy's 48 hours stop when the request arrived, so
 * the form's job is to capture that time truthfully.
 *
 * support.manage, required here as well as in the route map (which already
 * gives /admin/support/new the stricter key than the read-only queue) — a
 * page that files in batch0's name says what it needs where it does it.
 * logSupportRequest asserts it again.
 *
 * `?email=` and `?name=` prefill the requester, for links like "Log a request
 * for them" on a person's page. Both are only a starting value: a malformed
 * or oversized one is dropped rather than shown, and the form looks the
 * address up like any typed one.
 */
export default async function LogSupportRequestPage(props: {
  searchParams: Promise<RawSearchParams>;
}) {
  const [searchParams, { profile, caps }, inbox] = await Promise.all([
    props.searchParams,
    requirePermission("support.manage"),
    supportInboxAddress(),
  ]);
  const scope = supportScopeFor(profile.id, caps);

  const linkedEmail = (first(searchParams.email) ?? "").trim();
  const linkedName = Array.from((first(searchParams.name) ?? "").trim())
    .slice(0, REQUESTER_NAME_MAX)
    .join("")
    .trim();

  // Read once, here: the form's default and its bounds come from the same
  // instant, and the server render and hydration agree on it.
  const now = Date.now();

  return (
    <div className="mx-auto max-w-3xl pb-16">
      <Link
        href="/admin/support"
        prefetch={false}
        className="inline-flex items-center gap-1.5 text-sm text-ink-soft hover:text-ink"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Support queue
      </Link>

      <h1 className="mt-4 font-display text-3xl text-ink">Log a request</h1>
      <p className="mt-1 max-w-2xl text-sm text-ink-soft">
        For a request that came to {inbox ?? "the team inbox"} or by phone. It
        becomes a request like any other — in the queue, answered from its
        thread, counted with the rest. Put in the time it actually arrived:
        for a refund, that&rsquo;s the time the 48 hours are checked against,
        not the time you log it.
      </p>

      <Card className="mt-6">
        <LogRequestForm
          canSeeSensitive={scope.canSeeSensitive}
          defaultReceivedAt={toEasternLocalInput(now)}
          earliestReceivedAt={toEasternLocalInput(now - STAFF_LOG_MAX_AGE_DAYS * 86_400_000)}
          initialEmail={looksLikeEmail(linkedEmail) ? linkedEmail : ""}
          initialName={linkedName}
        />
      </Card>
    </div>
  );
}
