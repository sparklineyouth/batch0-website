import type { NextRequest } from "next/server";
import { asUuid } from "@/lib/chat-access";
import { answer, channelParam, fail } from "../respond";
import { readMessages } from "../reads";

/**
 * GET /chat/api/messages?c=<channel> → a page of messages:
 *   the newest page;
 *   &before=<iso>&beforeId=<uuid>  the page before that message (the oldest loaded);
 *   &around=<uuid>                 a window around one message.
 */
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const url = req.nextUrl;
  const channelId = channelParam(url);
  if (!channelId) return fail(400, "Pick a channel.");
  const before = url.searchParams.get("before");
  if (before && !Number.isFinite(Date.parse(before))) return fail(400, "That isn't a time.");
  const beforeId = asUuid(url.searchParams.get("beforeId"));
  const around = asUuid(url.searchParams.get("around"));
  return answer("messages", (reader) => readMessages(reader, channelId, { before, beforeId, around }));
}
