import type { NextRequest } from "next/server";
import { answer, channelParam, fail } from "../respond";
import { readMembers } from "../reads";

/** GET /chat/api/members?c=<channel> → who can read it, in name order (the first 300). */
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const channelId = channelParam(req.nextUrl);
  if (!channelId) return fail(400, "Pick a channel.");
  return answer("members", (reader) => readMembers(reader, channelId));
}
