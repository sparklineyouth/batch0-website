"use server";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertPermission } from "@/lib/server-guards";
import { logAudit } from "@/lib/audit";
import { notifyMany } from "@/lib/notifications";
import {
  THREAD_BODY_MAX,
  THREAD_TITLE_MAX,
  type DiscussionStatus,
} from "@/lib/discussions-access";

/**
 * The team's side of discussions: moderation and posting to a cohort. Replies
 * go through replyToThread in app/dashboard/discussions/actions.ts — same
 * action the student uses, so there is one place that decides who may speak
 * in a thread.
 *
 * Every action re-checks `discussions.manage`. Nothing here is reachable by
 * holding only admin-area access.
 */

const STUDENT_LIST = "/dashboard/discussions";
const TEAM_LIST = "/admin/discussions";

function revalidateThread(id: string) {
  revalidatePath(STUDENT_LIST);
  revalidatePath(`${STUDENT_LIST}/${id}`);
  revalidatePath(TEAM_LIST);
  revalidatePath(`${TEAM_LIST}/${id}`);
}

/** Resolve a question / lock a discussion, or the reverse. */
export async function setThreadStatus(input: {
  threadId: string;
  status: DiscussionStatus;
}): Promise<void> {
  await assertPermission("discussions.manage");
  if (input.status !== "open" && input.status !== "closed") {
    throw new Error("Bad status.");
  }
  const admin = createAdminClient();
  const { data: t } = await admin
    .from("discussion_threads")
    .select("id, visibility")
    .eq("id", input.threadId)
    .maybeSingle();
  if (!t) throw new Error("That thread isn't available.");

  const { error } = await admin
    .from("discussion_threads")
    .update({
      status: input.status,
      // Resolving a question takes it out of the queue; reopening one puts
      // it back, since the team reopened it to say something.
      ...(t.visibility === "admin" ? { needs_reply: false } : {}),
    })
    .eq("id", t.id);
  if (error) throw new Error(error.message);

  await logAudit({
    action: input.status === "closed" ? "discussion.closed" : "discussion.reopened",
    targetType: "discussion_thread",
    targetId: t.id,
    payload: { visibility: t.visibility },
  });
  revalidateThread(t.id);
}

/** Pin a cohort discussion to the top of the board. */
export async function setThreadPinned(input: {
  threadId: string;
  pinned: boolean;
}): Promise<void> {
  await assertPermission("discussions.manage");
  const admin = createAdminClient();
  const { data: t } = await admin
    .from("discussion_threads")
    .select("id, visibility")
    .eq("id", input.threadId)
    .maybeSingle();
  if (!t) throw new Error("That thread isn't available.");
  if (t.visibility !== "cohort") {
    throw new Error("Only cohort discussions can be pinned.");
  }
  const { error } = await admin
    .from("discussion_threads")
    .update({ pinned: !!input.pinned })
    .eq("id", t.id);
  if (error) throw new Error(error.message);
  await logAudit({
    action: input.pinned ? "discussion.pinned" : "discussion.unpinned",
    targetType: "discussion_thread",
    targetId: t.id,
  });
  revalidateThread(t.id);
}

/** Remove a whole thread. Replies cascade. */
export async function deleteThread(input: { threadId: string }): Promise<void> {
  await assertPermission("discussions.manage");
  const admin = createAdminClient();
  const { data: t } = await admin
    .from("discussion_threads")
    .select("id, visibility, title")
    .eq("id", input.threadId)
    .maybeSingle();
  if (!t) throw new Error("That thread isn't available.");

  // Bells that deep-link here would land on a 404 otherwise.
  await admin
    .from("notifications")
    .delete()
    .in("type", ["discussion_question", "discussion_reply"])
    .like("link", `%/discussions/${t.id}`);
  const { error } = await admin
    .from("discussion_threads")
    .delete()
    .eq("id", t.id);
  if (error) throw new Error(error.message);
  await logAudit({
    action: "discussion.deleted",
    targetType: "discussion_thread",
    targetId: t.id,
    payload: { visibility: t.visibility, title: t.title },
  });
  revalidateThread(t.id);
}

/** Remove one reply. The trigger recounts the thread. */
export async function deleteReply(input: { replyId: string }): Promise<void> {
  await assertPermission("discussions.manage");
  const admin = createAdminClient();
  const { data: r } = await admin
    .from("discussion_replies")
    .select("id, thread_id")
    .eq("id", input.replyId)
    .maybeSingle();
  if (!r) throw new Error("That reply isn't available.");
  const { error } = await admin
    .from("discussion_replies")
    .delete()
    .eq("id", r.id);
  if (error) throw new Error(error.message);
  await logAudit({
    action: "discussion_reply.deleted",
    targetType: "discussion_thread",
    targetId: r.thread_id,
    payload: { replyId: r.id },
  });
  revalidateThread(r.thread_id);
}

/**
 * The team starts a discussion for a cohort — an "introduce yourself"
 * thread, a prompt for the week. Everyone enrolled in the cohort gets a bell,
 * deduped per person so a retry can't double up.
 */
export async function createTeamThread(input: {
  cohortId: string;
  title: string;
  body: string;
  pinned?: boolean;
}): Promise<{ id: string }> {
  const { userId } = await assertPermission("discussions.manage");
  const title = input.title.replace(/\s+/g, " ").trim();
  const body = input.body.trim();
  if (!title) throw new Error("Give it a title.");
  if (title.length > THREAD_TITLE_MAX) {
    throw new Error(`Keep the title under ${THREAD_TITLE_MAX} characters.`);
  }
  if (!body) throw new Error("Write the post first.");
  if (body.length > THREAD_BODY_MAX) {
    throw new Error(`That post is too long (max ${THREAD_BODY_MAX} characters).`);
  }

  const admin = createAdminClient();
  const { data: cohort } = await admin
    .from("cohorts")
    .select("id, name")
    .eq("id", input.cohortId)
    .maybeSingle();
  if (!cohort) throw new Error("Pick a cohort.");

  const { data: created, error } = await admin
    .from("discussion_threads")
    .insert({
      cohort_id: cohort.id,
      author_id: userId,
      visibility: "cohort",
      title,
      body,
      is_staff: true,
      pinned: !!input.pinned,
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  const id = created!.id as string;

  try {
    const { data: rows } = await admin
      .from("enrollments")
      .select("user_id")
      .eq("cohort_id", cohort.id);
    await notifyMany(
      (rows ?? [])
        .map((r: any) => r.user_id as string)
        .filter((uid) => uid !== userId)
        .map((uid) => ({
          userId: uid,
          type: "discussion_reply",
          title: `New discussion from the batch0 team: ${title}`,
          body: body.slice(0, 200),
          link: `${STUDENT_LIST}/${id}`,
          dedupeKey: `discussion_thread:${id}:${uid}`,
        })),
    );
  } catch (err) {
    console.error("[discussions] team thread notify failed", err);
  }

  await logAudit({
    action: "discussion.created",
    targetType: "discussion_thread",
    targetId: id,
    payload: { cohortId: cohort.id, title, pinned: !!input.pinned },
  });
  revalidateThread(id);
  return { id };
}
