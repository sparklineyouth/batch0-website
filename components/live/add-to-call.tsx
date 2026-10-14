"use client";
import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { FieldError } from "@/components/ui/input";
import { getActionError } from "@/lib/action-error";
import { CohostPicker, type InviteeOption } from "@/components/live/invite-form";
import { addCallCohosts } from "@/app/calls/actions";
import { MAX_CALL_COHOSTS, type CallInvite } from "@/lib/live";
import { UserPlus } from "lucide-react";

/**
 * Putting more people on a booked 1:1. Both doors are `addCallCohosts`, which
 * decides everything again on the server:
 *
 *   AddPeopleForm    the staff side brings in more of the team
 *   JoinCallConfirm  a holder of calls.join_any (admins) adds THEMSELVES to
 *                    someone else's call, from /admin/calls
 *
 * Whoever is added is an ordinary co-host, named on every card and in the
 * room, and the student is told. There is no way back off a call.
 */

/** Who Add people may offer: the team minus everyone on the call; nobody once it's full. */
export function addableStaff(
  invite: Pick<CallInvite, "hostId" | "inviteeId" | "cohosts">,
  staff: readonly InviteeOption[],
): InviteeOption[] {
  if (invite.cohosts.length >= MAX_CALL_COHOSTS) return [];
  const onCall = new Set<string | undefined>([
    invite.hostId,
    invite.inviteeId,
    ...invite.cohosts.map((c) => c.id),
  ]);
  return staff.filter((s) => !onCall.has(s.id));
}

export function AddPeopleForm({
  inviteId,
  studentName,
  offer,
  already,
  onClose,
}: {
  inviteId: string;
  studentName: string;
  /** addableStaff(): the team, without anyone already on the call. */
  offer: InviteeOption[];
  /** Co-hosts the call already has. They count toward the limit. */
  already: number;
  onClose: () => void;
}) {
  const router = useRouter();
  const [ids, setIds] = useState<string[]>([]);
  const [error, setError] = useState<string | undefined>();
  const [pending, start] = useTransition();
  // Holds from the first click, so nobody is added (and notified) twice.
  const inFlight = useRef(false);

  function add() {
    if (inFlight.current || ids.length === 0) return;
    inFlight.current = true;
    setError(undefined);
    start(async () => {
      try {
        const result = await addCallCohosts(inviteId, ids);
        if (!result.ok) {
          setError(result.error);
          return;
        }
        router.refresh();
        onClose();
      } catch (err: any) {
        setError(getActionError(err));
      } finally {
        inFlight.current = false;
      }
    });
  }

  return (
    <div className="mt-4 space-y-3 border-t border-line pt-4">
      <CohostPicker
        staff={offer}
        value={ids}
        onChange={setIds}
        label="Add people from the team"
        already={already}
        autoFocus
      />
      <p className="text-xs text-ink-faint">{studentName} is told who&rsquo;s joining.</p>
      {error && <FieldError>{error}</FieldError>}
      <div className="flex gap-2">
        <Button size="sm" disabled={pending || ids.length === 0} onClick={add}>
          <UserPlus className="h-4 w-4" />
          {pending ? "Adding…" : "Add to call"}
        </Button>
        <Button size="sm" variant="ghost" disabled={pending} onClick={onClose}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/**
 * Join call / Add me on someone else's call (calls.join_any). With
 * `enterHref` (room open) it adds you and goes in; otherwise it adds you and
 * the call moves up into your own list.
 */
export function JoinCallConfirm({
  inviteId,
  viewerId,
  studentName,
  enterHref,
  onClose,
}: {
  inviteId: string;
  /** The viewer: the only person this ever adds. */
  viewerId: string;
  studentName: string;
  enterHref: string | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | undefined>();
  const [pending, start] = useTransition();
  // Never unset: what follows takes this card off the screen.
  const [done, setDone] = useState(false);
  const inFlight = useRef(false);

  function join() {
    if (inFlight.current) return;
    inFlight.current = true;
    setError(undefined);
    start(async () => {
      try {
        const result = await addCallCohosts(inviteId, [viewerId]);
        if (!result.ok) {
          setError(result.error);
          return;
        }
        setDone(true);
        if (enterHref) router.push(enterHref);
        else router.refresh();
      } catch (err: any) {
        setError(getActionError(err));
      } finally {
        inFlight.current = false;
      }
    });
  }

  const busy = pending || done;
  return (
    <div className="mt-4 space-y-3 border-t border-line pt-4">
      <p className="text-xs text-ink-faint">
        You join as part of the team, for good. {studentName} is told.
      </p>
      {error && <FieldError>{error}</FieldError>}
      <div className="flex gap-2">
        <Button size="sm" disabled={busy} onClick={join}>
          {enterHref ? (
            busy ? "Joining…" : "Join call"
          ) : (
            <>
              <UserPlus className="h-4 w-4" />
              {done ? "Added" : pending ? "Adding…" : "Add me"}
            </>
          )}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onClose}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
