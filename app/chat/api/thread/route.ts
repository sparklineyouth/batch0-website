import type { NextRequest } from "next/server";
import { asUuid } from "@/lib/chat-access";
import { answer, channelParam, fail } from "../respond";
import { readThread } from "../reads";

/**
 * GET /chat/api/thread?c=<channel>&root=<message> → one thread (0110): the
 * message it hangs off, its newest page of replies, and what the viewer may
 * do with it;
 *   &before=<iso>&beforeId=<uuid>  the replies before that one (the oldest loaded).
 * "Not available" (404) for a channel the viewer can't read, a root that
 * isn't a feed message in it, or before 0110 runs.
 */
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const url = req.nextUrl;
  const channelId = channelParam(url);
  const rootId = asUuid(url.searchParams.get("root"));
  if (!channelId || !rootId) return fail(400, "Pick a thread.");
  const before = url.searchParams.get("before");
  if (before && !Number.isFinite(Date.parse(before))) return fail(400, "That isn't a time.");
  const beforeId = asUuid(url.searchParams.get("beforeId"));
  return answer("thread", (reader) => readThread(reader, channelId, rootId, { before, beforeId }));
}
