import { ok } from "../respond";
import { currentReader, readAttention } from "../reads";

/**
 * GET /chat/api/attention → { n, userId }: the Chat nav badge's count, and
 * whose it is (the badge listens for that person's chat bells). On every
 * signed-in page, so it never fails: zero when signed out, before migration
 * 0101, or on any error. The cheap viewer path (getClaims), and a route
 * rather than a server action so it never queues ahead of someone's click.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  let reader = null;
  try {
    reader = await currentReader();
  } catch {
    reader = null;
  }
  return ok(await readAttention(reader));
}
