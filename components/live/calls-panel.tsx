"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { getActionError } from "@/lib/action-error";
import { InviteForm, type InviteDraft, type InviteeOption } from "@/components/live/invite-form";
import { CallSections } from "@/components/live/invite-card";
import { createInvite, cancelInvite } from "@/app/calls/actions";
import type { CallInvite } from "@/lib/live";
import { CalendarPlus, Video } from "lucide-react";

/**
 * The staff side of 1:1 calls — calls this person runs (as host or co-host) —
 * shared by /mentor/calls, /investor/calls and /admin/calls. "Start call now"
 * books it on the current minute and takes the host straight into the room.
 */
export function CallsPanel({
  invites,
  students,
  staff = [],
  now,
  emptyMessage = "No calls yet.",
}: {
  invites: CallInvite[];
  students: InviteeOption[];
  /** The team without the viewer: co-hosts on a new call, and Add people. */
  staff?: InviteeOption[];
  /** The server's render time (ISO). */
  now: string;
  emptyMessage?: string;
}) {
  const router = useRouter();
  const [composing, setComposing] = useState<"now" | "schedule" | null>(null);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | undefined>();

  function submit(draft: InviteDraft) {
    setError(undefined);
    start(async () => {
      try {
        const result = await createInvite(draft);
        if (!result.ok) {
          setError(result.error);
          return;
        }
        if (draft.startNow && result.data) {
          router.push(`/dashboard/calls/${result.data.id}/live`);
          return;
        }
        setComposing(null);
        router.refresh();
      } catch (err: any) {
        setError(getActionError(err));
      }
    });
  }

  function cancel(id: string) {
    if (!window.confirm("Cancel this call? The student is told.")) return;
    setError(undefined);
    start(async () => {
      try {
        const result = await cancelInvite(id);
        if (!result.ok) {
          setError(result.error);
          return;
        }
        router.refresh();
      } catch (err: any) {
        setError(getActionError(err));
      }
    });
  }

  if (composing) {
    return (
      <div>
        <h2 className="mb-4 text-sm font-semibold text-ink">
          {composing === "now" ? "Start a call now" : "Schedule a call"}
        </h2>
        <InviteForm
          key={composing}
          mode={composing}
          students={students}
          staff={staff}
          onSubmit={submit}
          onCancel={() => {
            setError(undefined);
            setComposing(null);
          }}
          pending={pending}
          error={error}
        />
      </div>
    );
  }

  return (
    <div>
      <div className="mb-5 flex flex-wrap justify-end gap-2">
        <Button variant="ghost" onClick={() => setComposing("schedule")}>
          <CalendarPlus className="h-4 w-4" /> Schedule
        </Button>
        <Button onClick={() => setComposing("now")}>
          <Video className="h-4 w-4" /> Start call now
        </Button>
      </div>

      <CallSections
        invites={invites}
        perspective="host"
        now={now}
        showRecording
        emptyMessage={emptyMessage}
        onCancel={cancel}
        pending={pending}
        staff={staff}
      />

      {error && <p className="mt-4 text-xs text-red-700 dark:text-red-400">{error}</p>}
    </div>
  );
}
