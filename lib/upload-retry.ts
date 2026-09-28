/**
 * Retry an upload through a network blip — and only a network blip.
 *
 * A recording segment is uploaded once, straight from the browser to Storage.
 * On a flaky connection that one attempt fails now and then, and a failed
 * segment is a hole in the recording: at End call it is the end of the
 * conversation, gone. So the room's `onSegment` wraps the upload in this.
 *
 * What is worth another try: no response at all (a dropped connection, a
 * DNS hiccup — the error carries no HTTP status), a 5xx, 408 or 429. What is
 * not: any other 4xx. A rejected file, an expired token or a refused path
 * fails the same way every time, and retrying it only delays saying so.
 *
 * Client-safe and dependency-free.
 */

export type RetryOptions = {
  /** Delays before the 2nd, 3rd, … attempt, in ms. Its length + 1 is the attempt count. */
  delaysMs?: readonly number[];
  /** Injected for tests. */
  sleep?: (ms: number) => Promise<void>;
};

/** The HTTP status an error carries, if any (supabase-js, fetch wrappers). */
function statusOf(err: unknown): number | null {
  const e = err as { status?: unknown; statusCode?: unknown } | null;
  const raw = e?.status ?? e?.statusCode;
  const n = typeof raw === "string" ? Number(raw) : raw;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

export function isRetryableUploadError(err: unknown): boolean {
  const status = statusOf(err);
  if (status === null) return true;
  return status >= 500 || status === 408 || status === 429;
}

export async function withUploadRetry<T>(
  attempt: () => Promise<T>,
  { delaysMs = [1_000, 3_000], sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }: RetryOptions = {},
): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await attempt();
    } catch (err) {
      if (i >= delaysMs.length || !isRetryableUploadError(err)) throw err;
      await sleep(delaysMs[i]);
    }
  }
}
