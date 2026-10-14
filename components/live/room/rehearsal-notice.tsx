"use client";
import { useEffect, useRef, useState } from "react";
import { LocalTime } from "@/components/ui/local-time";
import { RoomButton } from "./ui";

/**
 * A time in the viewer's zone, with its date unless it is today ("4:00 PM
 * today", "Oct 16, 4:00 PM"): a camera check on Tuesday for Thursday's
 * webinar must not read as this afternoon. Today is read after mount (the
 * viewer's day, not the server's).
 */
export function LocalWhen({ value }: { value: string }) {
  const [today, setToday] = useState(true);
  useEffect(() => {
    setToday(new Date(value).toDateString() === new Date().toDateString());
  }, [value]);
  return today ? (
    <>
      <LocalTime value={value} mode="time" /> today
    </>
  ) : (
    <LocalTime value={value} mode="datetime-short" />
  );
}

export type GoLiveNowOffer = {
  /** The scheduled start Go live now replaces. */
  startsAt: string;
  /** Who is told it's live, one sentence (goLiveNowAudience). */
  audience: string;
  busy: boolean;
  onConfirm: () => void;
};

/**
 * The notice a host rehearsing before the go-live window sees, and staff's
 * Go live now. Going live moves the event to now and tells its whole
 * audience (neither can be taken back), so like End it asks first, naming
 * the start it replaces and who is told.
 */
export function RehearsalNotice({ opensAt, goLive }: { opensAt: string; goLive?: GoLiveNowOffer | null }) {
  const [confirming, setConfirming] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const openRef = useRef<HTMLButtonElement>(null);
  const moved = useRef(false);
  // Focus follows the swap, so a keyboard user is never left on nothing; on
  // Cancel, so a second Enter doesn't go live.
  useEffect(() => {
    if (!moved.current) return;
    (confirming ? cancelRef : openRef).current?.focus();
  }, [confirming]);
  const swap = (next: boolean) => {
    moved.current = true;
    setConfirming(next);
  };

  if (goLive && confirming) {
    return (
      <>
        <span data-testid="go-live-confirm">
          Start now instead of <LocalWhen value={goLive.startsAt} />? The event moves to this minute.{" "}
          {goLive.audience}
        </span>
        <span className="pointer-events-auto inline-flex gap-2">
          <RoomButton
            variant="primary"
            size="sm"
            busy={goLive.busy}
            onClick={goLive.onConfirm}
            data-testid="go-live-now-confirm"
          >
            Go live now
          </RoomButton>
          <RoomButton ref={cancelRef} variant="ghost" size="sm" disabled={goLive.busy} onClick={() => swap(false)}>
            Cancel
          </RoomButton>
        </span>
      </>
    );
  }
  return (
    <>
      <span>
        Not live yet: students can join from <LocalWhen value={opensAt} />
      </span>
      {goLive ? (
        <button
          ref={openRef}
          type="button"
          className="pointer-events-auto font-semibold text-[#FFBB00] hover:underline"
          onClick={() => swap(true)}
          data-testid="go-live-now"
        >
          Go live now…
        </button>
      ) : null}
    </>
  );
}
