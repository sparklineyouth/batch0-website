"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, FieldError } from "@/components/ui/input";
import { approveTeamLogo, rejectTeamLogo } from "./actions";
import { getActionError } from "@/lib/action-error";

export function ModerationRow({ team }: { team: any }) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [showReason, setShowReason] = useState(false);
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | undefined>();

  function approve() {
    setErr(undefined);
    start(async () => {
      try {
        await approveTeamLogo({ teamId: team.id });
        router.refresh();
      } catch (e: any) {
        setErr(getActionError(e));
      }
    });
  }

  function reject() {
    setErr(undefined);
    start(async () => {
      try {
        await rejectTeamLogo({ teamId: team.id, reason });
        router.refresh();
      } catch (e: any) {
        setErr(getActionError(e));
      }
    });
  }

  const cohort = Array.isArray(team.cohort) ? team.cohort[0] : team.cohort;

  return (
    <Card className="!p-4">
      <div className="aspect-square w-full overflow-hidden rounded-lg border border-line bg-wash">
        {team.logo_url && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={team.logo_url}
            alt={`${team.name} logo`}
            className="h-full w-full object-cover"
          />
        )}
      </div>
      <div className="mt-3">
        <div className="text-sm font-semibold text-ink">{team.name}</div>
        {cohort?.name && (
          <div className="text-xs text-ink-faint">{cohort.name}</div>
        )}
        {team.logo_rejected_reason && (
          <p className="mt-1 text-xs text-amber-700/90 dark:text-amber-300/80">
            AI flagged: {team.logo_rejected_reason}
          </p>
        )}
      </div>

      {!showReason ? (
        <div className="mt-3 flex gap-2">
          <Button size="sm" onClick={approve} disabled={pending}>
            Approve
          </Button>
          <Button
            size="sm"
            variant="danger"
            onClick={() => setShowReason(true)}
            disabled={pending}
          >
            Reject
          </Button>
        </div>
      ) : (
        <div className="mt-3 space-y-2">
          <Input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Reason (sent to team)"
            maxLength={240}
          />
          <div className="flex gap-2">
            <Button size="sm" variant="danger" onClick={reject} disabled={pending}>
              {pending ? "Rejecting…" : "Confirm reject"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setShowReason(false)}
              disabled={pending}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
      <FieldError>{err}</FieldError>
    </Card>
  );
}
