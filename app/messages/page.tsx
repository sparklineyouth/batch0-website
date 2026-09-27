import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requireViewer, roleHome } from "@/lib/auth";
import { getDmViewer, listInbox } from "@/lib/dm";
import { MessagesInbox } from "./inbox";
import { buildThreadPayload } from "@/lib/dm-thread";

export const metadata = { title: "Messages · batch0" };
export const dynamic = "force-dynamic";

/**
 * The full messaging page. Deliberately at /messages and not under /dashboard:
 * every account has this feature, and /dashboard is gated on
 * `student.dashboard`, so a mentor following a "someone messaged you" link
 * into /dashboard/messages would have been bounced straight back out.
 * /notifications is here for the same reason.
 *
 * `?c=<conversationId>` opens a conversation (that's the notification link
 * target); `?to=<userId>` opens a draft to a person.
 */
export default async function MessagesPage(props: {
  searchParams?: Promise<{ c?: string; to?: string }>;
}) {
  const searchParams = await props.searchParams;
  const { profile, caps } = await requireViewer();
  // Real capabilities, not null: otherwise this page would resolve every
  // viewer as a non-moderator and disagree with the fetchThread action about
  // who may open a reported conversation.
  const viewer = await getDmViewer(profile.id, caps);

  const [home, rows, selected] = await Promise.all([
    roleHome(profile.role),
    listInbox(profile.id),
    buildThreadPayload(viewer, {
      conversationId: searchParams?.c,
      withUserId: searchParams?.to,
    }),
  ]);

  return (
    <div className="flex min-h-screen flex-col bg-paper text-ink">
      <div className="border-b border-line">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-4 md:px-8">
          <Link
            href={home}
            className="press inline-flex items-center gap-1.5 text-sm text-ink-soft hover:text-ink"
          >
            <ArrowLeft className="h-4 w-4" />
            Back
          </Link>
          <p className="font-mono text-[11px] font-medium uppercase tracking-[0.22em] text-phosphor-ink">
            Messages
          </p>
        </div>
      </div>

      <main
        id="main-content"
        tabIndex={-1}
        className="mx-auto flex w-full max-w-6xl flex-1 flex-col px-0 md:px-8 md:py-8"
      >
        <MessagesInbox
          viewerId={profile.id}
          initialRows={rows}
          initialThread={selected}
        />
      </main>
    </div>
  );
}
