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

  // A failed read shows the page with an error rather than a crash; the
  // client retries the list on its own.
  const [home, rows, selected] = await Promise.all([
    roleHome(profile.role),
    listInbox(profile.id).catch(() => null),
    buildThreadPayload(viewer, {
      conversationId: searchParams?.c,
      withUserId: searchParams?.to,
    }).catch(() => null),
  ]);

  return (
    // A fixed, full-viewport surface: the list and the thread each scroll in
    // their own pane, with the composer pinned to the bottom of the screen.
    // In normal flow the page grew with the conversation instead — it opened
    // on the oldest message with the composer a long scroll away — and a
    // 100dvh box would still overflow by the height of the sale banner above
    // it in the root layout.
    <div className="fixed inset-0 z-10 flex flex-col bg-paper text-ink">
      <div className="shrink-0 border-b border-line pt-[var(--safe-top)]">
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
        className="mx-auto flex min-h-0 w-full max-w-6xl flex-1 flex-col px-0 pb-[var(--safe-bottom)] md:px-8 md:py-8"
      >
        <MessagesInbox
          viewerId={profile.id}
          initialRows={rows ?? []}
          initialError={rows === null ? "Couldn't load your conversations." : null}
          initialThread={selected}
        />
      </main>
    </div>
  );
}
