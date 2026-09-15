"use server";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireActor } from "@/lib/server-guards";
import { getStudentAccess } from "@/lib/access";
import { checkRateLimit } from "@/lib/rate-limit";
import { notify, notifyMany } from "@/lib/notifications";
import { sendEmail } from "@/lib/email/send";
import { Templates } from "@/lib/email/templates";
import { env } from "@/lib/env";
import { logAudit } from "@/lib/audit";
import {
  getDiscussionViewer,
  listDiscussionTeamIds,
  listParticipantIds,
} from "@/lib/discussions";
import {
  canReadThread,
  canReplyToThread,
  THREAD_BODY_MAX,
  THREAD_TITLE_MAX,
  type DiscussionVisibility,
} from "@/lib/discussions-access";

/**
 * Server actions for discussions (migration 0068). Shared by the student
 * pages and the admin pages: a reply is a reply whoever posts it, and the
 * privacy rule is one function (lib/discussions-access.ts) — so the team's
 * reply composer and the student's call the same action and the same check.
 *
 * Every mutation re-derives the actor here. A server action is its own
 * entry point; the page guard is not what protects it.
 */

const STUDENT_LIST = "/dashboard/discussions";
const TEAM_LIST = "/admin/discussions";

function revalidateThread(id: string) {
  revalidatePath(STUDENT_LIST);
  revalidatePath(`${STUDENT_LIST}/${id}`);
  revalidatePath(TEAM_LIST);
  revalidatePath(`${TEAM_LIST}/${id}`);
}

function cleanTitle(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  if (!t) throw new Error("Give it a title.");
  if (t.length > THREAD_TITLE_MAX) {
    throw new Error(`Keep the title under ${THREAD_TITLE_MAX} characters.`);
  }
  return t;
}

function cleanBody(s: string, what = "message"): string {
  const b = s.trim();
  if (!b) throw new Error(`Write a ${what} first.`);
  if (b.length > THREAD_BODY_MAX) {
    throw new Error(`That ${what} is too long (max ${THREAD_BODY_MAX} characters).`);
  }
  return b;
}

async function actorName(userId: string): Promise<string> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("profiles")
    .select("full_name")
    .eq("id", userId)
    .maybeSingle();
  return (data as any)?.full_name?.trim() || "Someone";
}

// ---------------------------------------------------------------------------
// Start a thread
// ---------------------------------------------------------------------------

/**
 * A student starts a thread: a discussion for their cohort, or a private
 * question to the team. Staff post cohort discussions from the admin page
 * (createTeamThread), where they pick the cohort explicitly.
 */
export async function createThread(input: {
  visibility: DiscussionVisibility;
  title: string;
  body: string;
}): Promise<{ id: string }> {
  const actor = await requireActor();
  if (input.visibility !== "cohort" && input.visibility !== "admin") {
    throw new Error("Pick who this is for.");
  }
  const title = cleanTitle(input.title);
  const body = cleanBody(input.body, "post");

  const access = await getStudentAccess(actor.role);
  if (access.staff) {
    throw new Error("Post to a cohort from the admin Discussions page.");
  }
  if (!access.enrolled) {
    throw new Error("Discussions open once you're enrolled.");
  }
  if (input.visibility === "cohort" && !access.cohortId) {
    throw new Error("You aren't assigned to a cohort yet — ask the team privately instead.");
  }

  // Five new threads in ten minutes is a lot of asking; more is a stuck
  // button or a script.
  const rl = await checkRateLimit({
    kind: "discussion-thread",
    identifier: actor.userId,
    limit: 5,
    windowSeconds: 600,
  });
  if (!rl.ok) throw new Error("Slow down — you've posted a lot just now.");

  const admin = createAdminClient();
  const { data: created, error } = await admin
    .from("discussion_threads")
    .insert({
      cohort_id: access.cohortId,
      author_id: actor.userId,
      visibility: input.visibility,
      title,
      body,
      // A fresh question is by definition waiting on the team.
      needs_reply: input.visibility === "admin",
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  const id = created!.id as string;

  // Tell the team a question landed. Best-effort, and deduped per person so
  // a retry can't stack two bells for one ask.
  if (input.visibility === "admin") {
    try {
      const name = await actorName(actor.userId);
      const teamIds = await listDiscussionTeamIds();
      await notifyMany(
        teamIds
          .filter((uid) => uid !== actor.userId)
          .map((uid) => ({
            userId: uid,
            type: "discussion_question",
            title: `${name} asked the team: ${title}`,
            body: body.slice(0, 200),
            link: `${TEAM_LIST}/${id}`,
            dedupeKey: `discussion_question:${id}:${uid}`,
          })),
      );
    } catch (err) {
      console.error("[discussions] question notify failed", err);
    }
  }

  revalidateThread(id);
  return { id };
}

// ---------------------------------------------------------------------------
// Reply
// ---------------------------------------------------------------------------

export async function replyToThread(input: {
  threadId: string;
  body: string;
}): Promise<{ id: string }> {
  const actor = await requireActor();
  const body = cleanBody(input.body, "reply");

  const rl = await checkRateLimit({
    kind: "discussion-reply",
    identifier: actor.userId,
    limit: 10,
    windowSeconds: 60,
  });
  if (!rl.ok) throw new Error("Slow down — too many replies in a row.");

  const admin = createAdminClient();
  const [viewer, { data: t }] = await Promise.all([
    getDiscussionViewer(actor.userId, actor.caps),
    admin
      .from("discussion_threads")
      .select("id, visibility, cohort_id, author_id, status, title")
      .eq("id", input.threadId)
      .maybeSingle(),
  ]);
  // "Not found" for a thread you can't read, and for a thread that isn't
  // there — the same answer, on purpose (see getThreadForViewer). Only once
  // readability is settled does a closed thread get to say it's closed.
  const scope = t
    ? { visibility: t.visibility, cohortId: t.cohort_id, authorId: t.author_id }
    : null;
  if (!t || !scope || !canReadThread(scope, viewer)) {
    throw new Error("That thread isn't available.");
  }
  if (!canReplyToThread({ ...scope, status: t.status }, viewer)) {
    throw new Error(
      t.visibility === "admin"
        ? "This question is resolved. Reopen it to keep going."
        : "This discussion is locked.",
    );
  }

  const isStaff = viewer.manages;
  const { data: reply, error } = await admin
    .from("discussion_replies")
    .insert({
      thread_id: t.id,
      author_id: actor.userId,
      body,
      is_staff: isStaff,
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);

  // reply_count / last_activity_at are kept by a trigger (0068). On a
  // private question the ball changes court with every message: the team's
  // reply clears the flag, the student's follow-up raises it again.
  if (t.visibility === "admin") {
    await admin
      .from("discussion_threads")
      .update({ needs_reply: !isStaff })
      .eq("id", t.id);
  }

  // Fan-out. All best-effort.
  try {
    const name = await actorName(actor.userId);
    if (t.visibility === "admin") {
      if (isStaff) {
        // The moment the feature exists for: the team answered. Bell + email,
        // because a student who asked something may not be back on the
        // dashboard until told.
        if (t.author_id !== actor.userId) {
          await notify({
            userId: t.author_id,
            type: "discussion_reply",
            title: `${name} replied to your question`,
            body: body.slice(0, 200),
            link: `${STUDENT_LIST}/${t.id}`,
          });
          const { data: author } = await admin
            .from("profiles")
            .select("email, full_name")
            .eq("id", t.author_id)
            .maybeSingle();
          if ((author as any)?.email) {
            const tpl = Templates.discussionReply({
              name: (author as any).full_name,
              title: t.title,
              replierName: name,
              reply: body,
              threadUrl: `${env.siteUrl}${STUDENT_LIST}/${t.id}`,
            });
            await sendEmail({
              to: (author as any).email,
              subject: tpl.subject,
              html: tpl.html,
              templateKey: "discussion_reply",
            });
          }
        }
        await logAudit({
          action: "discussion.replied",
          targetType: "discussion_thread",
          targetId: t.id,
          payload: { visibility: t.visibility },
        });
      } else {
        // The student followed up — back to the team's queue.
        const teamIds = await listDiscussionTeamIds();
        await notifyMany(
          teamIds
            .filter((uid) => uid !== actor.userId)
            .map((uid) => ({
              userId: uid,
              type: "discussion_question",
              title: `${name} followed up: ${t.title}`,
              body: body.slice(0, 200),
              link: `${TEAM_LIST}/${t.id}`,
            })),
        );
      }
    } else {
      // Cohort discussion: the author and everyone who has already replied
      // hear about it; the rest of the cohort finds it on the board.
      const participants = await listParticipantIds(t.id);
      const recipients = new Set<string>([t.author_id, ...participants]);
      recipients.delete(actor.userId);
      await notifyMany(
        Array.from(recipients).map((uid) => ({
          userId: uid,
          type: "discussion_reply",
          title: `${name} replied to "${t.title}"`,
          body: body.slice(0, 200),
          link: `${STUDENT_LIST}/${t.id}`,
        })),
      );
      if (isStaff) {
        await logAudit({
          action: "discussion.replied",
          targetType: "discussion_thread",
          targetId: t.id,
          payload: { visibility: t.visibility },
        });
      }
    }
  } catch (err) {
    console.error("[discussions] reply notify failed", err);
  }

  revalidateThread(t.id);
  return { id: reply!.id as string };
}

// ---------------------------------------------------------------------------
// A student closes / reopens their own question
// ---------------------------------------------------------------------------

/**
 * The asker marks their own private question resolved (or reopens it).
 * Author-only, and only on `admin` threads — locking a cohort discussion is
 * the team's call (setThreadStatus in app/admin/discussions/actions.ts).
 */
export async function setOwnQuestionStatus(input: {
  threadId: string;
  status: "open" | "closed";
}): Promise<void> {
  const actor = await requireActor();
  if (input.status !== "open" && input.status !== "closed") {
    throw new Error("Bad status.");
  }
  const admin = createAdminClient();
  const { data: t } = await admin
    .from("discussion_threads")
    .select("id, visibility, author_id")
    .eq("id", input.threadId)
    .maybeSingle();
  if (!t || t.author_id !== actor.userId || t.visibility !== "admin") {
    throw new Error("That thread isn't available.");
  }
  const { error } = await admin
    .from("discussion_threads")
    .update({
      status: input.status,
      // A resolved question isn't waiting on anyone. Reopening it is a
      // follow-up, so it goes back in the queue.
      needs_reply: input.status === "open",
    })
    .eq("id", t.id);
  if (error) throw new Error(error.message);
  revalidateThread(t.id);
}
