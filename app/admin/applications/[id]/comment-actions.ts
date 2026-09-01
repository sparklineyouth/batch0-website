"use server";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertPermission } from "@/lib/server-guards";
import { logAudit } from "@/lib/audit";

export async function addReviewComment(input: {
  applicationId: string;
  body: string;
}): Promise<void> {
  const { userId } = await assertPermission("applications.view");
  const body = input.body.trim();
  if (!body) throw new Error("Comment can't be empty.");
  if (body.length > 5000) throw new Error("Comment is too long (5000 max).");

  const admin = createAdminClient();
  const { error } = await admin.from("application_review_comments").insert({
    application_id: input.applicationId,
    author_id: userId,
    body,
  });
  if (error) throw new Error(error.message);

  // Audit log so the trail of reviewer discussion is queryable from
  // /admin/audit alongside decisions. Comments themselves stay queryable
  // via the table directly — payload here is intentionally just the
  // length, not the body, to avoid duplicating large prose into the log.
  await logAudit({
    action: "application.review_comment_added",
    targetType: "application",
    targetId: input.applicationId,
    payload: { length: body.length },
  });

  revalidatePath(`/admin/applications/${input.applicationId}`);
}

export async function deleteReviewComment(input: {
  commentId: string;
  applicationId: string;
}): Promise<void> {
  // Comments are part of an audit-style discussion thread; only the
  // original author can delete their own. Admins can hard-delete via the
  // DB if something egregious lands.
  const { userId } = await assertPermission("applications.view");
  const admin = createAdminClient();
  const { data: row } = await admin
    .from("application_review_comments")
    .select("author_id")
    .eq("id", input.commentId)
    .maybeSingle();
  if (!row) throw new Error("Comment not found.");
  if (row.author_id !== userId) {
    throw new Error("Only the author can delete this comment.");
  }
  const { error } = await admin
    .from("application_review_comments")
    .delete()
    .eq("id", input.commentId);
  if (error) throw new Error(error.message);

  await logAudit({
    action: "application.review_comment_deleted",
    targetType: "application",
    targetId: input.applicationId,
    payload: { commentId: input.commentId },
  });

  revalidatePath(`/admin/applications/${input.applicationId}`);
}
