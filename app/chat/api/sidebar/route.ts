import type { NextRequest } from "next/server";
import { answer } from "../respond";
import { readSidebar } from "../reads";

/** GET /chat/api/sidebar → SidebarData: the left rail, polled while chat is open. */
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest) {
  return answer("sidebar", (reader) => readSidebar(reader));
}
