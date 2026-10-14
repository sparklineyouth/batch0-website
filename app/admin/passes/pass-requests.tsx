import { ExternalLink } from "lucide-react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { Card } from "@/components/ui/card";
import { LocalTime } from "@/components/ui/local-time";
import {
  listOpenFeedbackRequests,
  feedbackTopicLabel,
} from "@/lib/founder-pass-perks";
import { RespondForm } from "./respond-form";

/**
 * Redeemed feedback credits still waiting on a human, at the top of the
 * passes page (it used to be its own "Pass requests" page). Fulfilling one
 * delivers the write-up to the holder's pass page and emails them
 * (request-actions.ts). Seven-day rebuilds aren't here: they go through the
 * applications queue, badged for re-review. Renders nothing when the queue is
 * empty.
 */
export async function PassRequests({ admin }: { admin: SupabaseClient }) {
  const requests = await listOpenFeedbackRequests(admin);
  if (requests.length === 0) return null;

  // Holder names in one query, the same batching the passes ledger uses.
  const nameById = new Map<string, string>();
  const ids = Array.from(new Set(requests.map((r) => r.userId)));
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

  return (
    <section id="requests" className="mb-10 scroll-mt-24">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-faint">
        Feedback requests ({requests.length})
      </h2>
      <div className="mt-3 space-y-4">
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
    </section>
  );
}
