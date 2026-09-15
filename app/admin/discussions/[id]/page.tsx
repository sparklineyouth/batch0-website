import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireViewer } from "@/lib/auth";
import { ThreadView } from "@/components/discussions/thread-view";
import { AdminThreadControls } from "@/components/discussions/admin-thread-controls";
import {
  forStudent,
  getDiscussionViewer,
  getThreadForViewer,
  listReplies,
} from "@/lib/discussions";

export const metadata = { title: "Discussion · Admin" };
export const dynamic = "force-dynamic";

export default async function AdminDiscussionThreadPage(props: {
  params: Promise<{ id: string }>;
}) {
  const params = await props.params;
  // The layout has already required discussions.manage for this path; the
  // viewer is resolved again only to feed the same read the student page
  // uses, so there is exactly one code path that decides what a thread is.
  const { profile, caps } = await requireViewer();
  const viewer = await getDiscussionViewer(profile.id, caps);
  const thread = await getThreadForViewer(params.id, viewer);
  if (!thread) notFound();
  const replies = await listReplies(thread.id);

  const isPrivate = thread.visibility === "admin";

  return (
    <div className="mx-auto max-w-3xl">
      <Link
        href={isPrivate ? "/admin/discussions" : "/admin/discussions?view=cohort"}
        className="inline-flex items-center gap-1.5 text-xs text-ink-soft hover:text-ink"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Discussions
      </Link>

      {/* The team sees who's asking — name, email, cohort — above the thread.
          This block is the only place the email renders; ThreadView's prop
          shape has no room for it. */}
      <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-faint">
        <span>
          From{" "}
          <Link
            href={`/admin/students/${thread.authorId}`}
            className="text-ink hover:underline"
          >
            {thread.authorName}
          </Link>
          {thread.authorEmail && ` · ${thread.authorEmail}`}
        </span>
        {thread.cohortName && (
          <>
            <span aria-hidden>·</span>
            <span>{thread.cohortName}</span>
          </>
        )}
        {isPrivate && thread.needsReply && (
          <span className="rounded-full bg-phosphor/15 px-2 py-0.5 font-mono uppercase tracking-wider text-phosphor-ink">
            Awaiting reply
          </span>
        )}
      </div>

      <div className="mt-3">
        <ThreadView
          thread={forStudent(thread)}
          replies={replies.map(forStudent)}
          viewerId={profile.id}
          canModerate
          controls={
            <AdminThreadControls
              threadId={thread.id}
              title={thread.title}
              visibility={thread.visibility}
              status={thread.status}
              pinned={thread.pinned}
            />
          }
        />
      </div>
    </div>
  );
}
