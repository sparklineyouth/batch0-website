import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { isMissingSchemaError } from "@/lib/schema-ready";

/**
 * Sending a chat message exactly once (migration 0104).
 *
 * The composer gives every message an id of its own when it's written
 * (`chat_messages.client_id`), and every Retry of it sends that same id. A
 * send whose answer was lost — the row committed, the phone dropped off the
 * network before the reply came back — is retried with the id it already
 * used, and `unique (sender_id, client_id)` makes a second row impossible:
 * the retry gets the ORIGINAL row back instead of posting the words twice.
 * Two messages someone means to send, even word for word the same, have two
 * ids and stay two messages.
 *
 * Scoped to the author. The key is the pair, and every lookup here asks for
 * the caller's own sender id, so nobody can claim (or block) an id of someone
 * else's.
 *
 * Production gets this code before 0104 runs. Until then the column isn't
 * there: a send goes in without it, as it did before, nothing is replayed,
 * and reads leave it out. That's found out by asking, and a "not there" is
 * remembered for a minute, so it costs one failed query a minute per
 * instance rather than one per message (lib/live-access.ts does the same for
 * 0096's column). Once it's there it stays there.
 */

const CLIENT_ID_RECHECK_MS = 60_000;
let clientIdsReadyNow = false;
let clientIdsMissingUntil = 0;

/** 0104's column isn't there: send and read without it for a minute. */
export function noteClientIdsMissing(now = Date.now()): void {
  clientIdsReadyNow = false;
  clientIdsMissingUntil = now + CLIENT_ID_RECHECK_MS;
}

/** For tests: forget what this instance found out. */
export function resetClientIdState(): void {
  clientIdsReadyNow = false;
  clientIdsMissingUntil = 0;
}

/**
 * Does chat_messages have 0104's client_id? Asked with a read that returns
 * no rows. Any failure other than "it isn't there" answers no for this call
 * only, so a blip never turns client ids off for a minute — and never takes
 * a send down: the caller just goes without.
 */
export async function clientIdsReady(): Promise<boolean> {
  if (clientIdsReadyNow) return true;
  if (Date.now() < clientIdsMissingUntil) return false;
  const { error } = await createAdminClient().from("chat_messages").select("client_id").limit(0);
  if (!error) {
    clientIdsReadyNow = true;
    return true;
  }
  if (isMissingSchemaError(error)) noteClientIdsMissing();
  return false;
}

/** What a resend needs to know about the message that already went in. */
export type SentRow = { id: string; channel_id: string; created_at: string; deleted_at: string | null };

/**
 * The message this sender already sent with this client id, or null — none,
 * or a database from before 0104. Fails closed on any other error: a lookup
 * that couldn't run must not read as "not sent yet" and post it again.
 */
export async function findSentMessage(senderId: string, clientId: string): Promise<SentRow | null> {
  if (!(await clientIdsReady())) return null;
  const { data, error } = await createAdminClient()
    .from("chat_messages")
    .select("id, channel_id, created_at, deleted_at")
    .eq("sender_id", senderId)
    .eq("client_id", clientId)
    .maybeSingle();
  if (error) {
    if (isMissingSchemaError(error)) {
      noteClientIdsMissing();
      return null;
    }
    throw new Error(`Couldn't check whether that message already went through: ${error.message}`);
  }
  return (data as SentRow | null) ?? null;
}

/** 23505: the unique key said no — here, only ever (sender_id, client_id). */
const UNIQUE_VIOLATION = "23505";

/**
 * Insert one message row. With a client id (and 0104 in place) it carries
 * it, and a row this sender already sent with that id comes back as
 * `duplicate` instead of a second one: two requests for the same message at
 * once (a Retry racing a slow first send) both end on the one row. Without
 * the column, the row goes in as it always did.
 */
export async function insertMessageOnce(
  row: Record<string, unknown> & { sender_id: string },
  clientId: string | null,
): Promise<{ inserted: { id: string; created_at: string } } | { duplicate: SentRow }> {
  const admin = createAdminClient();
  const put = (values: Record<string, unknown>) => admin.from("chat_messages").insert(values).select("id, created_at").single();
  if (clientId && (await clientIdsReady())) {
    const { data, error } = await put({ ...row, client_id: clientId });
    if (!error) return { inserted: data as { id: string; created_at: string } };
    if ((error as { code?: string }).code === UNIQUE_VIOLATION) {
      // The other request committed first (a unique check waits for it):
      // its row is the message.
      const original = await findSentMessage(row.sender_id, clientId);
      if (original) return { duplicate: original };
      throw new Error(error.message);
    }
    if (!isMissingSchemaError(error)) throw new Error(error.message);
    noteClientIdsMissing();
  }
  const { data, error } = await put(row);
  if (error) throw new Error(error.message);
  return { inserted: data as { id: string; created_at: string } };
}
