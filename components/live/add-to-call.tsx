"use client";
import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { FieldError } from "@/components/ui/input";
import { getActionError } from "@/lib/action-error";
import { CohostPicker, type InviteeOption } from "@/components/live/invite-form";
import { addCallCohosts } from "@/app/calls/actions";
import { MAX_CALL_COHOSTS, type CallInvite } from "@/lib/live";
import { Info, UserPlus } from "lucide-react";

/**
 * Putting more people on a 1:1 that is already booked.
 *
 * Co-hosts used to be chosen once, on the form that sent the invite, and never
 * again: a host who wanted a colleague along after the student had accepted
 * had no way to do it short of cancelling the call and booking a new one, and
 * an admin reading the safeguarding list had no way into a call at all. There
 * are two doors now, and both are `addCallCohosts` (app/calls/actions.ts),
 * which decides everything that matters again on the server — who may add, who
 * may be added, the limit, and whether the call can still happen:
 *
 *   AddPeopleForm    anyone on the call's staff side brings in more of the
 *                    team, through the picker the booking forms use
 *   JoinCallConfirm  a holder of calls.join_any (admins) puts THEMSELVES on
 *                    someone else's call, from the list on /admin/calls
 *
 * Whichever door, the person added is an ordinary co-host, and visibly so:
 * named on every card and in the room, and the student is told who is now
 * joining. There is no way into a call that the people on it cannot see, and
 * no way back off one — so both doors say so before the click, not after.
 *
 * Each owns its pending state and its error, and shows the error on the card
 * it belongs to. The calls lists have one error slot, at the bottom, and a
 * refusal there would not say which of twenty calls it was about.
 */

/**
 * Who Add people may offer on this call: the team (the page has already left
 * the viewer out) without the host, the student or anyone already a co-host —
 * and nobody at all once the staff side is at MAX_CALL_COHOSTS, so a full call
 * shows no Add people rather than a picker that cannot pick.
 *
 * The server skips anyone already on the call and refuses past the limit
 * whatever this says; it is only so the picker never offers what the server
 * would ignore. A CallInvite read without `hostId` / `inviteeId` leaves those
 * two to the server, which drops them (normalizeCohostIds).
 */
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

/**
 * "Add people", opened from a card on the staff side's own calls list.
 *
 * Add stays disabled until someone is picked, and the picker counts the call's
 * existing co-hosts toward the limit. Success refreshes the list, which is what
 * puts the new names on the card. Someone who turns out to be on the call
 * already (a second tab, a colleague who got there first) is skipped by the
 * server rather than refused, so that is a success too.
 */
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
  // `pending` disables the button from the next render; this holds from the
  // first click, so the same additions can never be sent twice at once — and
  // everyone they name notified twice.
  const inFlight = useRef(false);

  function add() {
    if (inFlight.current || ids.length === 0) return;
    inFlight.current = true;
    setError(undefined);
    start(async () => {
      try {
        // Refusals come back as a result, with the sentence intact — see
        // addCallCohosts.
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
        hint={
          <>
            They can join, end or cancel the call, and watch it back.{" "}
            {studentName} is told who&rsquo;s joining. There&rsquo;s no taking
            anyone off a call afterwards.
          </>
        }
      />
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
 * Join call / Add me, on someone else's call in the list on /admin/calls, for
 * a viewer who holds calls.join_any.
 *
 * A confirm rather than a single press, because of what the press does: it
 * puts you on a student's call for good and tells the student you are coming.
 * One sentence before that is cheaper than an apology after a stray click in a
 * list of a hundred calls.
 *
 * `enterHref` set (the room is open): add, then straight into the room, the
 * same one every participant's Join opens. Null (it has not opened yet): add,
 * then refresh, which moves the call up into the viewer's own list, where it
 * has the staff side's controls from then on.
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
  // Set once the add has gone through, and never unset. What comes next (the
  // room loading, or the refresh that moves this call up into the viewer's
  // own list) takes this card off the screen, the transition can settle
  // before it does, and until then the buttons must not come back to life
  // for a second press of something that already happened.
  const [done, setDone] = useState(false);
  // See AddPeopleForm.
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
      <p className="flex items-start gap-1.5 text-xs text-ink-faint">
        <Info className="mt-px h-3.5 w-3.5 shrink-0" />
        <span>
          {enterHref ? (
            <>
              You&rsquo;ll join as part of the team, and everyone on the call
              sees you.
            </>
          ) : (
            <>
              You&rsquo;ll be added as part of the team, and the call moves up
              to your own list.
            </>
          )}{" "}
          {studentName} is told you&rsquo;re joining. There&rsquo;s no taking
          yourself off a call afterwards.
        </span>
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
