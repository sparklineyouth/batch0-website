import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card } from "@/components/ui/card";
import { LocalTime } from "@/components/ui/local-time";
import {
  listOpenFeedbackRequests,
  feedbackTopicLabel,
} from "@/lib/founder-pass-perks";
import { ExternalLink } from "lucide-react";
import { RespondForm } from "./respond-form";

export const metadata = { title: "Pass requests · Admin" };
export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * The founder-pass feedback-credit inbox: every redeemed credit still awaiting a
 * human. Fulfilling one delivers the written feedback to the holder's pass page
 * and emails them (see actions.ts). The rebuild perk isn't here — those flow
 * through the applications queue, badged for re-review next to the applicant.
 */
export default async function AdminPassRequestsPage() {
  const admin = createAdminClient();
  const requests = await listOpenFeedbackRequests(admin);

  // Resolve holder names in one query, the same batching pattern the
  // applications queue and the passes admin use.
  const nameById = new Map<string, string>();
  const ids = Array.from(new Set(requests.map((r) => r.userId)));
  if (ids.length) {
    const { data } = await admin
      .from("profiles")
      .select("id, full_name, email")
      .in("id", ids);
    for (const p of (data ?? []) as Array<{
      id: string;
      full_name: string | null;
      email: string | null;
    }>) {
      nameById.set(p.id, p.full_name || p.email || "Unknown");
    }
  }

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-8">
        <h1 className="font-display text-3xl text-ink">Pass requests</h1>
        <p className="mt-2 text-sm text-ink-soft">
          Founder-pass holders who redeemed their feedback credit. Deliver
          feedback here and it lands on their pass and in their inbox.
        </p>
      </div>

      {requests.length === 0 ? (
        <Card>
          <p className="text-sm text-ink-faint">
            No open feedback requests. When a holder redeems their credit,
            it&apos;ll appear here.
          </p>
        </Card>
      ) : (
        <div className="space-y-4">
          {requests.map((r) => (
            <Card key={r.id}>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div>
                  <span className="text-sm font-semibold text-ink">
                    {nameById.get(r.userId) ?? "Unknown"}
                  </span>
                  <span className="ml-2 text-sm text-ink-soft">
                    · {feedbackTopicLabel(r.topic)}
                  </span>
                </div>
                <span className="font-mono text-xs text-ink-faint">
                  <LocalTime value={r.createdAt} mode="date" />
                </span>
              </div>
              {r.detail && (
                <p className="mt-2 whitespace-pre-wrap break-words text-sm text-ink-soft">
                  {r.detail}
                </p>
              )}
              {r.linkUrl && (
                <a
                  href={r.linkUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-2 inline-flex items-center gap-1.5 text-sm font-medium text-phosphor-ink underline underline-offset-4"
                >
                  Their link <ExternalLink className="h-3.5 w-3.5" />
                </a>
              )}
              {r.status === "scheduled" && (
                <p className="mt-2 text-xs text-ink-faint">
                  Scheduled for a clinic — deliver the write-up here when done.
                </p>
              )}
              <RespondForm requestId={r.id} />
            </Card>
          ))}
        </div>
      )}

      <p className="mt-8 text-center text-xs text-ink-faint">
        Looking for seven-day rebuilds?{" "}
        <Link
          href="/admin/applications"
          className="underline underline-offset-4"
        >
          They&apos;re in the applications queue
        </Link>
        , badged for re-review.
      </p>
    </div>
  );
}
