import { NextResponse, type NextRequest } from "next/server";
import { getViewer } from "@/lib/auth";
import { getChannelForViewer, getChatViewer, getMessageRow } from "@/lib/chat";
import { isInlineImage } from "@/lib/chat-files-rules";
import { signChatFile } from "@/lib/chat-files";

/**
 * One file on a chat message. Re-authorizes on every request — the viewer
 * must be able to read the message's channel right now — then redirects to a
 * 10-minute signed URL. The URL on the page is worthless once copied off it,
 * and someone removed from a team loses its files the moment they lose the
 * channel. Images open inline; everything else downloads under its own name.
 */
export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ messageId: string; index: string }> },
) {
  const { messageId, index } = await ctx.params;
  const notFound = () => new NextResponse("Not found", { status: 404, headers: { "cache-control": "no-store" } });
  const viewer = await getViewer();
  if (!viewer) return NextResponse.redirect(new URL(`/login?next=/chat`, req.url));
  const row = await getMessageRow(messageId).catch(() => null);
  if (!row || row.deleted_at) return notFound();
  const chatViewer = await getChatViewer(viewer.profile.id, viewer.caps);
  const found = await getChannelForViewer(row.channel_id, chatViewer).catch(() => null);
  if (!found) return notFound();
  const files = Array.isArray(row.attachments) ? row.attachments : [];
  const i = Number(index);
  const file = Number.isInteger(i) && i >= 0 ? files[i] : null;
  if (!file?.path) return notFound();
  const download = req.nextUrl.searchParams.get("download") === "1" || !isInlineImage(file);
  const url = await signChatFile(file.path, download ? { downloadName: String(file.name ?? "file") } : {});
  if (!url) return notFound();
  return NextResponse.redirect(url, { status: 302, headers: { "cache-control": "private, max-age=300" } });
}
