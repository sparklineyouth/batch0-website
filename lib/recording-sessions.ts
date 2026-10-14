import "server-only";

// STUB — replaced by WS-E's real lib/recording-sessions.ts (recording_sessions, migration 0095).
// Until then no room reports a running recording. `roomId` is the raw event or call-invite uuid.
export async function activeRecordingFor(kind: 'webinar' | 'call', roomId: string): Promise<{ sessionId: string; byUserId: string; byName: string; startedAt: string } | null> { return null }
