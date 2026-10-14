/**
 * Placeholder slot for recording playback. WS-E (recording) ships the real
 * module at this path with the same `EventRecordings` signature; at
 * integration take WS-E's file. Renders nothing here.
 */
export function EventRecordings(_props: {
  eventId: string;
  /** Shown when there is nothing; omitted, nothing renders. */
  emptyText?: string;
}) {
  return null;
}
