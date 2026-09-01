"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertPermission } from "@/lib/server-guards";
import { logAudit } from "@/lib/audit";
import { drainEmailQueue } from "@/lib/email/queue";
import { sanitizeEmailHtml } from "@/lib/email/sanitize";
import {
  renderTemplate,
  renderAdHoc,
  renderBodyFragment,
} from "@/lib/email/render";
import { getTemplateById, toStoredTemplate } from "@/lib/email/store";

/**
 * Outbox controls.
 *
 * The queue is the one place an admin can still change their mind — once a
 * row leaves it, the email is in somebody's inbox and no amount of admin UI
 * gets it back. So cancelling is the primary action here, and it's available
 * on anything still pending.
 */

export async function cancelQueued(
  id: string,
): Promise<{ ok: boolean; error?: string }> {
  await assertPermission("email.send");
  const admin = createAdminClient();
  // `.eq("status","pending")` is the guard, not the UI: between the page
  // render and the click, the drainer may have already picked this row up.
  // Better a no-op than marking a sent email as cancelled.
  const { data, error } = await admin
    .from("email_outbox")
    .update({
      status: "canceled",
      last_error: "Cancelled by an admin",
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("status", "pending")
    .select("id, to_email");
  if (error) return { ok: false, error: error.message };
  if (!data || data.length === 0) {
    return { ok: false, error: "Too late — that one already left the queue." };
  }

  await logAudit({
    action: "email.outbox_canceled",
    targetType: "email_outbox",
    targetId: id,
    payload: { to: data[0].to_email },
  });
  revalidatePath("/admin/email/outbox");
  return { ok: true };
}

/** Cancel everything still pending. The panic button. */
export async function cancelAllPending(): Promise<{
  ok: boolean;
  message: string;
}> {
  await assertPermission("email.send");
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("email_outbox")
    .update({
      status: "canceled",
      last_error: "Bulk cancelled by an admin",
      updated_at: new Date().toISOString(),
    })
    .eq("status", "pending")
    .select("id");
  if (error) return { ok: false, message: error.message };

  const count = data?.length ?? 0;
  await logAudit({
    action: "email.outbox_bulk_canceled",
    targetType: "email_outbox",
    payload: { count },
  });
  revalidatePath("/admin/email/outbox");
  return {
    ok: true,
    message:
      count === 0
        ? "Nothing was waiting."
        : `Cancelled ${count} queued email${count === 1 ? "" : "s"}.`,
  };
}

/** Put a failed or cancelled row back in the queue. */
export async function retryQueued(
  id: string,
): Promise<{ ok: boolean; error?: string }> {
  await assertPermission("email.send");
  const admin = createAdminClient();
  const { error } = await admin
    .from("email_outbox")
    .update({
      status: "pending",
      // Reset the counter — this is a deliberate human retry, and it
      // shouldn't inherit the automatic retry budget the row already spent.
      attempts: 0,
      last_error: null,
      send_after: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .in("status", ["failed", "canceled", "skipped"]);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/admin/email/outbox");
  return { ok: true };
}

/**
 * Drain the queue now, without waiting for cron.
 *
 * Mostly for the first five minutes after setting something up, when waiting
 * a cron interval to find out whether it works is the difference between
 * confidence and a support ticket.
 */
export async function runQueueNow(): Promise<{ ok: boolean; message: string }> {
  await assertPermission("email.send");
  const report = await drainEmailQueue();
  await logAudit({
    action: "email.queue_run_manual",
    targetType: "email_outbox",
    payload: report as any,
  });
  revalidatePath("/admin/email/outbox");

  if (report.paused) {
    return {
      ok: false,
      message: "Automated sending is paused — nothing was sent.",
    };
  }
  const parts = [
    `${report.sent} sent`,
    report.failed > 0 ? `${report.failed} failed` : null,
    report.skipped > 0 ? `${report.skipped} skipped by a condition` : null,
    report.queued > 0 ? `${report.queued} newly queued` : null,
  ].filter(Boolean);
  return {
    ok: report.errors.length === 0,
    message:
      parts.join(", ") +
      (report.errors.length > 0 ? ` — ${report.errors.join("; ")}` : ""),
  };
}

// ---------------------------------------------------------------------------
// Editing a queued email
// ---------------------------------------------------------------------------

/**
 * Everything an admin can change about mail that hasn't left yet.
 *
 * Editing is only ever offered on a `pending` row, and every write below is
 * conditioned on `status = 'pending'` as well. The gap between rendering the
 * form and submitting it is a real window — the drainer runs on its own clock
 * and may claim the row mid-edit — and the right outcome then is a refusal
 * that says so, not an update that silently applies to an email already gone.
 */
export type QueuedEdit = {
  id: string;
  toEmail: string;
  toName: string;
  /** ISO instant. */
  sendAfter: string;
  subject: string;
  bodyHtml: string;
};

const QUEUE_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function updateQueuedEmail(
  edit: QueuedEdit,
): Promise<{ ok: boolean; error?: string }> {
  const { userId } = await assertPermission("email.send");

  const to = edit.toEmail.trim();
  if (!QUEUE_EMAIL_RE.test(to)) {
    return { ok: false, error: `"${to}" isn't a valid email address.` };
  }
  const when = new Date(edit.sendAfter);
  if (Number.isNaN(when.getTime())) {
    return { ok: false, error: "That send time isn't a real date." };
  }

  const admin = createAdminClient();
  const { data: row } = await admin
    .from("email_outbox")
    .select("id, status, template_id, to_email")
    .eq("id", edit.id)
    .maybeSingle();
  if (!row) return { ok: false, error: "That queued email no longer exists." };
  if (row.status !== "pending") {
    return {
      ok: false,
      error: `Too late — this one is already "${row.status}" and can't be edited.`,
    };
  }

  const patch: Record<string, any> = {
    to_email: to,
    to_name: edit.toName.trim() || null,
    send_after: when.toISOString(),
    updated_at: new Date().toISOString(),
  };

  // Copy is only writable on a detached row. A template-backed row renders
  // from the template at send time, so storing a body on it would be a value
  // the sender silently ignores — the UI routes those through detach() first.
  if (!row.template_id) {
    const subject = edit.subject.trim();
    if (!subject) return { ok: false, error: "Subject is required." };
    const bodyHtml = sanitizeEmailHtml(edit.bodyHtml ?? "");
    if (!bodyHtml.replace(/<[^>]+>/g, "").trim()) {
      return { ok: false, error: "The email body can't be empty." };
    }
    // Stored as a fragment; the shell and the merge tags are applied when it
    // sends (see sendQueuedRow). Round-tripping a wrapped document through
    // the editor would nest the branded shell inside itself on every save.
    patch.subject_override = subject;
    patch.html_override = bodyHtml;
  }

  const { data: updated, error } = await admin
    .from("email_outbox")
    .update(patch)
    .eq("id", edit.id)
    .eq("status", "pending")
    .select("id");
  if (error) return { ok: false, error: error.message };
  if (!updated || updated.length === 0) {
    return { ok: false, error: "That email left the queue while you were editing it." };
  }

  await logAudit({
    action: "email.outbox_edited",
    targetType: "email_outbox",
    targetId: edit.id,
    payload: {
      to: to,
      // Worth recording explicitly: an admin redirecting a queued email to a
      // different address is exactly the action you'd want to find later.
      previousTo: row.to_email !== to ? row.to_email : undefined,
      sendAfter: when.toISOString(),
      copyEdited: !row.template_id,
      editor: userId,
    },
  });
  revalidatePath("/admin/email/outbox");
  revalidatePath(`/admin/email/outbox/${edit.id}`);
  return { ok: true };
}

/**
 * Freeze the template's current output onto this one row and cut the link.
 *
 * The alternative designs are both worse. Editing the template itself would
 * change the wording for everyone else queued against it, which is not what
 * "edit this email" means. Storing a body while leaving `template_id` set
 * would have the drainer re-render from the template and throw the edit away
 * at send time — a change that appears to save and then doesn't happen.
 *
 * So detaching is explicit and one-way, and the UI says so before it happens.
 */
export async function detachQueuedEmail(
  id: string,
): Promise<{ ok: boolean; error?: string }> {
  await assertPermission("email.send");
  const admin = createAdminClient();

  const { data: row } = await admin
    .from("email_outbox")
    .select("id, status, template_id, variables")
    .eq("id", id)
    .maybeSingle();
  if (!row) return { ok: false, error: "That queued email no longer exists." };
  if (row.status !== "pending") {
    return { ok: false, error: `Already "${row.status}" — nothing to detach.` };
  }
  if (!row.template_id) return { ok: true }; // already detached

  const tpl = await getTemplateById(row.template_id);
  if (!tpl) return { ok: false, error: "The template behind this email is gone." };

  const stored = toStoredTemplate(tpl);
  const { data: updated, error } = await admin
    .from("email_outbox")
    .update({
      template_id: null,
      subject_override: stored.subject,
      html_override: renderBodyFragment(stored),
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("status", "pending")
    .select("id");
  if (error) return { ok: false, error: error.message };
  if (!updated || updated.length === 0) {
    return { ok: false, error: "That email left the queue before it could be detached." };
  }

  await logAudit({
    action: "email.outbox_detached",
    targetType: "email_outbox",
    targetId: id,
    payload: { fromTemplate: tpl.key },
  });
  revalidatePath(`/admin/email/outbox/${id}`);
  revalidatePath("/admin/email/outbox");
  return { ok: true };
}

/** Move a queued email to the front — it goes on the next drain. */
export async function sendQueuedNow(
  id: string,
): Promise<{ ok: boolean; error?: string }> {
  await assertPermission("email.send");
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("email_outbox")
    .update({ send_after: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("status", "pending")
    .select("id");
  if (error) return { ok: false, error: error.message };
  if (!data || data.length === 0) {
    return { ok: false, error: "That one isn't waiting in the queue any more." };
  }
  await logAudit({
    action: "email.outbox_expedited",
    targetType: "email_outbox",
    targetId: id,
  });
  revalidatePath("/admin/email/outbox");
  return { ok: true };
}

/** What this queued row will actually look like when it sends. */
export async function previewQueued(
  id: string,
): Promise<
  | { ok: true; subject: string; html: string; source: "template" | "frozen" }
  | { ok: false; error: string }
> {
  await assertPermission("email.view");
  const admin = createAdminClient();
  const { data: row } = await admin
    .from("email_outbox")
    .select("template_id, variables, subject_override, html_override")
    .eq("id", id)
    .maybeSingle();
  if (!row) return { ok: false, error: "That queued email no longer exists." };

  if (row.template_id) {
    const tpl = await getTemplateById(row.template_id);
    if (!tpl) return { ok: false, error: "The template behind this email is gone." };
    const rendered = renderTemplate(toStoredTemplate(tpl), row.variables ?? {});
    return { ok: true, subject: rendered.subject, html: rendered.html, source: "template" };
  }
  const adhoc = renderAdHoc({
    subject: row.subject_override ?? "",
    bodyHtml: row.html_override ?? "",
    values: row.variables ?? {},
  });
  return { ok: true, subject: adhoc.subject, html: adhoc.html, source: "frozen" };
}

/** The row as the edit form needs it. Body comes back as an editable fragment. */
export async function loadQueuedEmail(id: string): Promise<
  | {
      ok: true;
      row: {
        id: string;
        status: string;
        toEmail: string;
        toName: string;
        sendAfter: string;
        subject: string;
        bodyHtml: string;
        templateId: string | null;
        templateName: string | null;
        automationName: string | null;
        variables: Record<string, string>;
      };
    }
  | { ok: false; error: string }
> {
  await assertPermission("email.view");
  const admin = createAdminClient();
  const { data: row } = await admin
    .from("email_outbox")
    .select(
      "id, status, to_email, to_name, send_after, subject_override, html_override, template_id, variables, template:email_templates(name), automation:email_automations(name)",
    )
    .eq("id", id)
    .maybeSingle();
  if (!row) return { ok: false, error: "That queued email no longer exists." };

  const template = Array.isArray((row as any).template)
    ? (row as any).template[0]
    : (row as any).template;
  const automation = Array.isArray((row as any).automation)
    ? (row as any).automation[0]
    : (row as any).automation;

  // A template-backed row has no copy of its own yet — show what the template
  // currently renders, so the admin sees the real words before deciding to
  // detach rather than an empty editor.
  let subject = row.subject_override ?? "";
  let bodyHtml = row.html_override ?? "";
  if (row.template_id) {
    const tpl = await getTemplateById(row.template_id);
    if (tpl) {
      const stored = toStoredTemplate(tpl);
      subject = stored.subject;
      bodyHtml = renderBodyFragment(stored);
    }
  }

  return {
    ok: true,
    row: {
      id: row.id,
      status: row.status,
      toEmail: row.to_email,
      toName: row.to_name ?? "",
      sendAfter: row.send_after,
      subject,
      bodyHtml,
      templateId: row.template_id,
      templateName: template?.name ?? null,
      automationName: automation?.name ?? null,
      variables: (row.variables ?? {}) as Record<string, string>,
    },
  };
}
