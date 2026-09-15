import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireViewer } from "@/lib/auth";
import { getStudentAccess } from "@/lib/access";
import { LockedFeature } from "@/components/dashboard/locked-feature";
import { ThreadView } from "@/components/discussions/thread-view";
import { OwnQuestionControls } from "@/components/discussions/own-question-controls";
import {
  forStudent,
  getDiscussionViewer,
  getThreadForViewer,
  listReplies,
} from "@/lib/discussions";

// Static title on purpose: a per-thread title would have to read the thread
// before the viewer check, and a private question's title is private.
export const metadata = { title: "Discussion · batch0" };
export const dynamic = "force-dynamic";

export default async function DiscussionThreadPage(props: {
  params: Promise<{ id: string }>;
}) {
  const params = await props.params;
  const { profile, caps } = await requireViewer();
  const access = await getStudentAccess(profile.role);
  if (!access.enrolled) {
    return (
      <LockedFeature
        title="Discussions"
        applicationStatus={access.applicationStatus}
      />
    );
  }

  const viewer = await getDiscussionViewer(profile.id, caps);
  // Null for "doesn't exist" and for "not yours to read" alike — a private
  // question must not confirm it exists to anyone but its author and the
  // team. Either way, 404.
  const thread = await getThreadForViewer(params.id, viewer);
  if (!thread) notFound();
  const replies = await listReplies(thread.id);

  const isPrivate = thread.visibility === "admin";
  const backHref = isPrivate
    ? "/dashboard/discussions?tab=questions"
    : "/dashboard/discussions";

  return (
    <div className="mx-auto max-w-3xl">
      <Link
        href={backHref}
        className="inline-flex items-center gap-1.5 text-xs text-ink-soft hover:text-ink"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        {isPrivate ? "My questions" : "Discussions"}
      </Link>
      <div className="mt-4">
        <ThreadView
          thread={forStudent(thread)}
          replies={replies.map(forStudent)}
          viewerId={profile.id}
          canModerate={viewer.manages}
          controls={
            isPrivate && thread.authorId === profile.id ? (
              <OwnQuestionControls threadId={thread.id} status={thread.status} />
            ) : undefined
          }
        />
      </div>
    </div>
  );
}
