import { NextResponse, type NextRequest } from "next/server";
import { getViewer } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { getChatViewer, getReport } from "@/lib/chat";
import { isInlineImage, parseChatUploadPath } from "@/lib/chat-files-rules";
import { signChatFile } from "@/lib/chat-files";

/**
 * A file from a reported channel for the moderator working the report —
 * including one on a message deleted before the report, which the chat's own
 * file route no longer serves (its words are in the revisions; this is where
 * its files are). chat.manage, a report this moderator may see (getReport:
 * never one about them), and a path staged in that report's channel; then a
 * redirect to a 10-minute signed URL, never cached.
 *
 *   ?p=<path>   the stored path (chat_messages / chat_message_revisions attachments)
 *   ?n=<name>   the file's name, for the download
 *   ?t=<type>   its stored type: a png/jpeg/gif/webp image opens inline, anything else downloads
 */
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const headers = { "cache-control": "no-store" };
  const notFound = () => new NextResponse("Not found", { status: 404, headers });
  try {
    const { id } = await ctx.params;
    const viewer = await getViewer();
    if (!viewer) return NextResponse.redirect(new URL(`/login?next=/admin/chat`, req.url), { headers });
    if (!can(viewer.caps, "chat.manage")) return notFound();
    const report = await getReport(id, await getChatViewer(viewer.profile.id, viewer.caps));
    if (!report) return notFound();
    const path = req.nextUrl.searchParams.get("p") ?? "";
    const staged = parseChatUploadPath(path);
    if (!staged || staged.channelId !== report.channelId) return notFound();
    const name = (req.nextUrl.searchParams.get("n") ?? "file").slice(0, 200) || "file";
    const type = req.nextUrl.searchParams.get("t") ?? "";
    const inline = isInlineImage({ name, type }) && req.nextUrl.searchParams.get("download") !== "1";
    const url = await signChatFile(path, inline ? {} : { downloadName: name });
    if (!url) return notFound();
    return NextResponse.redirect(url, { status: 302, headers });
  } catch (err) {
    console.error("[admin/chat/reports/file]", err);
    return notFound();
  }
}
