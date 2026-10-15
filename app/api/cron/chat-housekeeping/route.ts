import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { env } from "@/lib/env";
import { isMissingSchemaError } from "@/lib/schema-ready";
import { CHAT_FILES_BUCKET } from "@/lib/chat-files-rules";
import { sweepUnsentChatFiles, type OrphanSweepReport } from "@/lib/chat-housekeeping";
import { isMissingBucket } from "@/lib/support-housekeeping";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The sweep walks the bucket one listing after another; the default 10s
// would cut it off partway. 300, like the other daily crons.
export const maxDuration = 300;

/**
 * Chat's daily chore: delete uploads nobody sent (lib/chat-housekeeping.ts
 * has the rules and why each one is shaped the way it is).
 *
 * Once a day at 13:30 UTC (vercel.json), half an hour after
 * support-housekeeping so the two bucket walks never overlap. A database
 * where migration 0101 hasn't run (no bucket, no chat_files_in_use) is a note
 * in a 200, not an incident. Anything else that stops the sweep, and the
 * mass-deletion guard, answer 500 with `ok: false` so the cron log shows it.
 */

/** Nothing new starts after this much of the run. */
const SOFT_DEADLINE_MS = 240_000;
/** Per listing and per lookup: neither has a timeout of its own. */
const CALL_TIMEOUT_MS = 15_000;

export async function GET(req: Request) {
  // Fail closed when CRON_SECRET isn't configured, like every other cron here.
  if (!env.cronSecret) {
    return new Response("CRON_SECRET not configured", { status: 500 });
  }
  if (req.headers.get("authorization") !== `Bearer ${env.cronSecret}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const startedAt = Date.now();
  const admin = createAdminClient();
  const bucket = admin.storage.from(CHAT_FILES_BUCKET);
  let report: Omit<OrphanSweepReport, "notes"> | null = null;
  const notes: string[] = [];
  let ok = true;
  try {
    const { notes: sweepNotes, ...counts } = await sweepUnsentChatFiles({
      storage: {
        list: (prefix, page) =>
          bucket.list(
            prefix,
            { limit: page.limit, offset: page.offset, sortBy: { column: "name", order: "asc" } },
            { signal: AbortSignal.timeout(CALL_TIMEOUT_MS) },
          ),
        remove: (paths) => bucket.remove(paths),
      },
      findInUse: async (paths) => {
        const { data, error } = await admin
          .rpc("chat_files_in_use", { p_paths: paths })
          .abortSignal(AbortSignal.timeout(CALL_TIMEOUT_MS));
        if (error) return { data: null, error };
        // setof text comes back as a list of strings; anything else is a
        // failed read, never "nothing is in use".
        return { data: Array.isArray(data) ? (data as unknown[]).filter((p): p is string => typeof p === "string") : null, error: null };
      },
      now: startedAt,
      deadline: startedAt + SOFT_DEADLINE_MS,
    });
    report = counts;
    notes.push(...sweepNotes);
    if (counts.halted) ok = false;
    if (counts.halted || counts.errors > 0) console.error("[cron/chat-housekeeping] sweep:", sweepNotes.join(" | "));
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    if (isMissingBucket(error) || isMissingSchemaError(error)) {
      notes.push(`skipped — migration 0101 isn't applied here yet (${error.message})`);
    } else {
      ok = false;
      notes.push(`sweep failed: ${error.message}`);
      console.error("[cron/chat-housekeeping] sweep failed", error.message);
    }
  }
  return NextResponse.json({ ok, unsentUploads: report, notes }, { status: ok ? 200 : 500 });
}
