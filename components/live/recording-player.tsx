"use client";

/**
 * Placeholder slots for recording playback. WS-E (recording) ships the real
 * player at this path with the same `EventRecordings` and `CallRecordings`
 * signatures; at integration take WS-E's file. Both render nothing here.
 */
export function EventRecordings(_props: {
  eventId: string;
  /** Shown when there is nothing; omitted, nothing renders. */
  emptyText?: string;
}) {
  return null;
}

/** A call's recording on its card (invite-card's Past cards). */
export function CallRecordings(_props: { inviteId: string }) {
  return null;
}
