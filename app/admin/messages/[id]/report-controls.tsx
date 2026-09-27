"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LocalTime } from "@/components/ui/local-time";
import type { ReportStatus } from "@/lib/dm-access";
import { resolveReport } from "../actions";

/**
 * Close out one report. Two outcomes on purpose: "actioned" means we did
 * something about it, "dismissed" means there was nothing to do. Neither
 * un-reports the conversation — the report, and the read access it granted,
 * stay on the record.
 */
export function ReportControls({
  reportId,
  status,
  reviewedAt,
}: {
  reportId: string;
  status: ReportStatus;
  reviewedAt: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function resolve(next: "actioned" | "dismissed") {
    setBusy(true);
    setError(null);
    const res = await resolveReport({ reportId, status: next });
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    router.refresh();
  }

  if (status !== "open") {
    return (
      <p className="shrink-0 text-right text-[10px] text-ink-faint">
        <span className="capitalize">{status}</span>
        {reviewedAt && (
          <>
            {" · "}
            <LocalTime value={reviewedAt} mode="date" />
          </>
        )}
      </p>
    );
  }

  return (
    <div className="shrink-0 text-right">
      <div className="flex gap-1.5">
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => resolve("actioned")}>
          <Check className="h-3 w-3" />
          Actioned
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => resolve("dismissed")}>
          <X className="h-3 w-3" />
          Dismiss
        </Button>
      </div>
      {error && (
        <p role="alert" className="mt-1 text-[10px] text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}
