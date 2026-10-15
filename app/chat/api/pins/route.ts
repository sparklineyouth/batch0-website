import type { NextRequest } from "next/server";
import { answer, channelParam, fail } from "../respond";
import { readPins } from "../reads";

/** GET /chat/api/pins?c=<channel> → its pinned messages, newest first, and their people. */
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const channelId = channelParam(req.nextUrl);
  if (!channelId) return fail(400, "Pick a channel.");
  return answer("pins", (reader) => readPins(reader, channelId));
}
