import type { NextRequest } from "next/server";
import { asUuid } from "@/lib/chat-access";
import { answer, channelParam, fail } from "../respond";
import { readMessagesById } from "../reads";

/** GET /chat/api/messages-by-id?c=<channel>&ids=<uuid,uuid> → those messages (up to 50), and their people. */
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const url = req.nextUrl;
  const channelId = channelParam(url);
  if (!channelId) return fail(400, "Pick a channel.");
  const ids = (url.searchParams.get("ids") ?? "")
    .split(",")
    .slice(0, 50)
    .map(asUuid)
    .filter((id): id is string => !!id);
  return answer("messages-by-id", (reader) => readMessagesById(reader, channelId, ids));
}
