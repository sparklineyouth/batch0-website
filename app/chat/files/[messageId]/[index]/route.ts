import { NextResponse, type NextRequest } from "next/server";
import { getViewer } from "@/lib/auth";
import { getMessageRow, openChannelFor } from "@/lib/chat";
import { isInlineImage } from "@/lib/chat-files-rules";
import { signChatFile } from "@/lib/chat-files";

/**
 * One file on a chat message. Re-authorizes on every request — the viewer
 * must be able to read the message's channel right now — then redirects to a
 * 10-minute signed URL. Nothing is cached (no-store), so the check runs again
 * on every view: someone removed from a team, or looking at a message its
 * sender has since deleted, gets a 404 on their next request. The signed URL
 * itself lives its ten minutes, which is why it's minted per view and never
 * put on the page. Images open inline; everything else downloads under its
 * own name.
 *
 * Cheap on purpose — every image in a channel is a request: the viewer comes
 * from the locally verified JWT, and is resolved for this one channel only
 * (openChannelFor). Never a 500: anything that fails is a 404.
 */
export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ messageId: string; index: string }> },
) {
  const headers = { "cache-control": "no-store" };
  const notFound = () => new NextResponse("Not found", { status: 404, headers });
  try {
    const { messageId, index } = await ctx.params;
    const viewer = await getViewer();
    if (!viewer) return NextResponse.redirect(new URL(`/login?next=/chat`, req.url), { headers });
    const row = await getMessageRow(messageId);
    if (!row || row.deleted_at) return notFound();
    const found = await openChannelFor(row.channel_id, viewer.profile.id, viewer.caps);
    if (!found) return notFound();
    const files = Array.isArray(row.attachments) ? row.attachments : [];
    const i = Number(index);
    const file = Number.isInteger(i) && i >= 0 ? files[i] : null;
    if (!file?.path) return notFound();
    const download = req.nextUrl.searchParams.get("download") === "1" || !isInlineImage(file);
    const url = await signChatFile(file.path, download ? { downloadName: String(file.name ?? "file") } : {});
    if (!url) return notFound();
    return NextResponse.redirect(url, { status: 302, headers });
  } catch (err) {
    console.error("[chat/files]", err);
    return notFound();
  }
}
