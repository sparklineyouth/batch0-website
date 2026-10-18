import type { NextRequest } from "next/server";
import { answer, channelParam, fail } from "../respond";
import { readUnanswered } from "../reads";

/** GET /chat/api/unanswered?c=<#help> → its open questions (0110), waiting longest first, and how many there are. */
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const channelId = channelParam(req.nextUrl);
  if (!channelId) return fail(400, "Pick a channel.");
  return answer("unanswered", (reader) => readUnanswered(reader, channelId));
}
