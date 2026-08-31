import { createAdminClient } from "@/lib/supabase/admin";
import { env } from "@/lib/env";
import { sendEmail, type EmailResult } from "@/lib/email/send";
import { renderTemplate, renderAdHoc } from "@/lib/email/render";
import { getEmailSettings, formatFrom } from "@/lib/email/settings";
import {
  automationsForEvent,
  getTemplateByKey,
  getTemplateById,
  toStoredTemplate,
  isMissingTable,
  type TemplateRow,
} from "@/lib/email/store";
import { firstNameOf, type VariableValues } from "@/lib/email/vars";

/**
 * The send path everything user-facing goes through.
 *
 * Two jobs:
 *
 * 1. `sendTemplated(key, …)` — send the email named `key`, preferring the
 *    admin-editable row in `email_templates` and falling back to the compiled
 *    function the call site passes in. This is what makes every transactional
 *    email editable without making any of them fragile: an admin can rewrite
 *    the acceptance email, and if they disable it, delete the row, or the
 *    migration hasn't run, the original copy still goes out.
 *
 * 2. `emitEmailEvent(event, …)` — announce that something happened, and let
 *    whatever automations an admin has built off that event fire. Steps with
 *    no delay send inline; delayed steps land in `email_outbox` for the cron
 *    drainer.
 *
 * Both swallow their failures. Email is a side effect of accepting an
 * applicant or taking a payment — it must never be the reason one of those
 * fails.
 */

export type FallbackEmail = { subject: string; html: string; text?: string };

export type TemplatedArgs = {
  to: string;
  toName?: string | null;
  /** The profile behind `to`, when there is one. Fills the common variables. */
  userId?: string | null;
  vars?: VariableValues;
  /**
   * The compiled template to use when the database row is absent or disabled.
   * A thunk, so the (occasionally expensive) render only happens if it's used.
   */
  fallback?: () => FallbackEmail;
  /** Collapses retries of the same logical send into one email. */
  dedupeKey?: string;
  replyTo?: string;
  /** Subject prefix for test sends — "[TEST] …". */
  subjectPrefix?: string;
};

/** Variables every template can rely on, resolved from the recipient. */
export function baseVariables(args: {
  email: string;
  name?: string | null;
}): VariableValues {
  return {
    email: args.email,
    full_name: args.name ?? "",
    first_name: firstNameOf(args.name, "there"),
    name: firstNameOf(args.name, "there"),
    site_url: env.siteUrl,
    dashboard_url: `${env.siteUrl}/dashboard`,
    contact_email: env.contactEmail,
  };
}

/**
 * Send the template named `key`.
 *
 * Returns the transport result. Callers generally ignore it — see the note
 * above about email never failing the operation it reports on — but the admin
 * surfaces (test send, one-off compose) show it.
 */
export async function sendTemplated(
  key: string,
  args: TemplatedArgs,
): Promise<EmailResult> {
  try {
    const row = await getTemplateByKey(key);
    const vars = { ...baseVariables({ email: args.to, name: args.toName }), ...args.vars };

    if (row && row.enabled) {
      const rendered = renderTemplate(toStoredTemplate(row), vars);
      // A required variable with no value means the copy has a hole in it —
      // "Hi {{first_name}}, your {{cohort_name}} seat…" with a blank cohort
      // reads as broken. Fall back to the compiled version rather than send it.
      if (rendered.missing.length > 0) {
        console.error(
          `[email] template ${key} missing required variables: ${rendered.missing.join(", ")}`,
        );
        return sendFallback(key, args);
      }
      const settings = await getEmailSettings();
      return sendEmail({
        to: args.to,
        subject: prefixed(rendered.subject, args.subjectPrefix),
        html: rendered.html,
        text: rendered.text,
        templateKey: key,
        replyTo: args.replyTo ?? row.reply_to ?? undefined,
        from: row.from_email
          ? formatFrom({
              fromName: row.from_name ?? settings.fromName,
              fromEmail: row.from_email,
            })
          : undefined,
      });
    }
    return sendFallback(key, args);
  } catch (err) {
    console.error("[email] sendTemplated threw", key, err);
    return sendFallback(key, args);
  }
}

function prefixed(subject: string, prefix?: string): string {
  return prefix ? `${prefix} ${subject}` : subject;
}

async function sendFallback(
  key: string,
  args: TemplatedArgs,
): Promise<EmailResult> {
  if (!args.fallback) {
    return { ok: false, reason: `No template "${key}" and no fallback` };
  }
  const f = args.fallback();
  return sendEmail({
    to: args.to,
    subject: prefixed(f.subject, args.subjectPrefix),
    html: f.html,
    text: f.text,
    templateKey: key,
    replyTo: args.replyTo,
  });
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type EmailEventContext = {
  /** Who the automation should write to. */
  email: string | null | undefined;
  name?: string | null;
  userId?: string | null;
  /** Event-specific merge values (see lib/email/catalog.ts). */
  vars?: VariableValues;
  /**
   * Stable id for the thing that happened — an application id, a payment id.
   * It's what stops a webhook redelivery or a double-clicked Accept button
   * from starting the same drip twice, so pass one whenever the event has a
   * natural key.
   */
  dedupeSeed?: string;
};

/**
 * Fire an event. Every enabled automation listening on it queues (or sends)
 * its steps for this recipient.
 *
 * Fire-and-forget by design: callers `void emitEmailEvent(...)` or await it
 * without checking, and a failure here is logged, not thrown.
 */
export async function emitEmailEvent(
  eventKey: string,
  ctx: EmailEventContext,
): Promise<{ queued: number; sent: number }> {
  const result = { queued: 0, sent: 0 };
  const to = ctx.email?.trim();
  if (!to) return result;

  try {
    const settings = await getEmailSettings();
    const automations = await automationsForEvent(eventKey);
    if (automations.length === 0) return result;

    const vars = { ...baseVariables({ email: to, name: ctx.name }), ...ctx.vars };

    for (const automation of automations) {
      for (const step of automation.steps) {
        const dedupeKey = ctx.dedupeSeed
          ? `evt:${automation.id}:${step.id}:${ctx.dedupeSeed}`
          : `evt:${automation.id}:${step.id}:${to.toLowerCase()}:${dedupeBucket(
              automation.dedupe_window_hours,
            )}`;

        // A step with no delay is the transactional case — "send the welcome
        // email now". Routing it through the queue would add up to a full
        // cron interval of latency to an email the recipient is actively
        // waiting for, so it goes out inline. The queue row is still written
        // first, which is what makes the dedupe key do its job.
        if (step.delay_minutes === 0 && !settings.automationsPaused) {
          const claimed = await claimImmediate({
            automationId: automation.id,
            stepId: step.id,
            templateId: step.template_id,
            to,
            toName: ctx.name ?? null,
            userId: ctx.userId ?? null,
            vars,
            dedupeKey,
          });
          if (!claimed) continue; // already sent — a duplicate trigger
          const ok = await sendQueuedRow(claimed);
          if (ok) result.sent++;
          continue;
        }

        const queued = await enqueueEmail({
          automationId: automation.id,
          stepId: step.id,
          templateId: step.template_id,
          to,
          toName: ctx.name ?? null,
          userId: ctx.userId ?? null,
          vars,
          sendAfter: new Date(Date.now() + step.delay_minutes * 60_000),
          dedupeKey,
        });
        if (queued) result.queued++;
      }
    }
  } catch (err) {
    console.error("[email] emitEmailEvent failed", eventKey, err);
  }
  return result;
}

/**
 * Is this stored copy a complete HTML document rather than a body fragment?
 *
 * Only true for outbox rows written before the queue switched to storing
 * fragments. The rich-text editor and the sanitizer both strip `<html>` and
 * `<head>`, so a fragment can never look like one by accident.
 */
function isFullDocument(html: string): boolean {
  const head = html.slice(0, 200).toLowerCase();
  return head.includes("<!doctype") || head.includes("<html");
}

/** Hour bucket, so a repeat trigger inside the window collapses. */
function dedupeBucket(windowHours: number): string {
  if (windowHours <= 0) return String(Date.now());
  const ms = windowHours * 3600_000;
  return String(Math.floor(Date.now() / ms));
}

// ---------------------------------------------------------------------------
// Outbox
// ---------------------------------------------------------------------------

export type EnqueueArgs = {
  automationId?: string | null;
  stepId?: string | null;
  templateId?: string | null;
  to: string;
  toName?: string | null;
  userId?: string | null;
  vars?: VariableValues;
  sendAfter?: Date;
  dedupeKey?: string | null;
  /** For a one-off with no template behind it. */
  subjectOverride?: string | null;
  htmlOverride?: string | null;
};

/**
 * Put an email in the outbox. Returns the row id, or null when the dedupe key
 * says we already have this one.
 */
export async function enqueueEmail(args: EnqueueArgs): Promise<string | null> {
  try {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from("email_outbox")
      .insert({
        automation_id: args.automationId ?? null,
        step_id: args.stepId ?? null,
        template_id: args.templateId ?? null,
        to_email: args.to,
        to_name: args.toName ?? null,
        user_id: args.userId ?? null,
        variables: args.vars ?? {},
        subject_override: args.subjectOverride ?? null,
        html_override: args.htmlOverride ?? null,
        send_after: (args.sendAfter ?? new Date()).toISOString(),
        dedupe_key: args.dedupeKey ?? null,
        status: "pending",
      })
      .select("id")
      .single();
    if (error) {
      // 23505 is the dedupe index doing its job — not a failure.
      if ((error as any).code === "23505") return null;
      if (!isMissingTable(error)) {
        console.error("[email] enqueue failed", error.message);
      }
      return null;
    }
    return data?.id ?? null;
  } catch (err) {
    console.error("[email] enqueue threw", err);
    return null;
  }
}

export type QueuedRow = {
  id: string;
  template_id: string | null;
  to_email: string;
  to_name: string | null;
  user_id: string | null;
  variables: VariableValues;
  subject_override: string | null;
  html_override: string | null;
  automation_id: string | null;
  step_id: string | null;
};

/**
 * Insert a row already claimed for immediate sending.
 *
 * Written as `sending` rather than `pending` so the cron drainer, which may
 * be running at this exact moment, doesn't pick up the same row and send it
 * a second time. The unique dedupe index is what makes the claim atomic.
 */
async function claimImmediate(args: {
  automationId: string;
  stepId: string;
  templateId: string;
  to: string;
  toName: string | null;
  userId: string | null;
  vars: VariableValues;
  dedupeKey: string;
}): Promise<QueuedRow | null> {
  try {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from("email_outbox")
      .insert({
        automation_id: args.automationId,
        step_id: args.stepId,
        template_id: args.templateId,
        to_email: args.to,
        to_name: args.toName,
        user_id: args.userId,
        variables: args.vars,
        send_after: new Date().toISOString(),
        dedupe_key: args.dedupeKey,
        status: "sending",
      })
      .select(
        "id, template_id, to_email, to_name, user_id, variables, subject_override, html_override, automation_id, step_id",
      )
      .single();
    if (error) return null;
    return data as QueuedRow;
  } catch {
    return null;
  }
}

/**
 * Render and send one outbox row, then record what happened.
 *
 * Rendering happens here rather than at enqueue time on purpose: a template
 * edited while a drip is in flight applies to the mail that hasn't gone out
 * yet. That's what an admin expects when they fix a typo in a sequence
 * that's mid-send.
 */
export async function sendQueuedRow(
  row: QueuedRow,
  /**
   * Per-drain template cache. A fan-out is N rows against one or two
   * templates, so without this the drainer re-fetches the same row once per
   * recipient — 200 identical SELECTs on a 200-person step.
   */
  templateCache?: Map<string, TemplateRow | null>,
): Promise<boolean> {
  const admin = createAdminClient();
  try {
    let subject: string;
    let html: string;
    let text: string | undefined;
    let templateKey: string | undefined;
    let from: string | undefined;
    let replyTo: string | undefined;

    if (row.template_id) {
      let tpl: TemplateRow | null;
      if (templateCache?.has(row.template_id)) {
        tpl = templateCache.get(row.template_id)!;
      } else {
        tpl = await getTemplateById(row.template_id);
        templateCache?.set(row.template_id, tpl);
      }
      if (!tpl || !tpl.enabled) {
        await finish(admin, row.id, {
          status: "skipped",
          error: tpl ? "Template is disabled" : "Template was deleted",
        });
        return false;
      }
      const rendered = renderTemplate(toStoredTemplate(tpl), row.variables ?? {});
      if (rendered.missing.length > 0) {
        await finish(admin, row.id, {
          status: "failed",
          error: `Missing required variables: ${rendered.missing.join(", ")}`,
        });
        return false;
      }
      subject = rendered.subject;
      html = rendered.html;
      text = rendered.text;
      templateKey = tpl.key;
      replyTo = tpl.reply_to ?? undefined;
      if (tpl.from_email) {
        const settings = await getEmailSettings();
        from = formatFrom({
          fromName: tpl.from_name ?? settings.fromName,
          fromEmail: tpl.from_email,
        });
      }
    } else if (row.subject_override && row.html_override) {
      // `html_override` is normally a BODY FRAGMENT. Wrapping it here rather
      // than at enqueue time means a queued one-off picks up the current
      // branded shell, and its merge tags resolve against the recipient at the
      // moment it sends — the same contract the template path has.
      //
      // Rows queued before that change stored a fully-rendered document
      // instead. Re-wrapping one would nest the branded shell inside itself
      // and send a visibly doubled email, so a finished document is detected
      // and passed through untouched. Cheap, and it only has to be right for
      // rows already in flight — nothing writes this shape any more.
      if (isFullDocument(row.html_override)) {
        subject = row.subject_override;
        html = row.html_override;
      } else {
        const adhoc = renderAdHoc({
          subject: row.subject_override,
          bodyHtml: row.html_override,
          values: row.variables ?? {},
        });
        subject = adhoc.subject;
        html = adhoc.html;
        text = adhoc.text;
      }
    } else {
      await finish(admin, row.id, {
        status: "failed",
        error: "Row has neither a template nor rendered content",
      });
      return false;
    }

    const result = await sendEmail({
      to: row.to_email,
      subject,
      html,
      text,
      templateKey,
      from,
      replyTo,
    });

    await finish(admin, row.id, {
      status: result.ok ? "sent" : "failed",
      error: result.ok ? null : (result.reason ?? "unknown"),
      providerId: result.id ?? null,
    });
    return result.ok;
  } catch (err: any) {
    await finish(admin, row.id, {
      status: "failed",
      error: err?.message ?? "unknown error",
    });
    return false;
  }
}

async function finish(
  admin: ReturnType<typeof createAdminClient>,
  id: string,
  args: { status: string; error?: string | null; providerId?: string | null },
) {
  try {
    await admin
      .from("email_outbox")
      .update({
        status: args.status,
        last_error: args.error ?? null,
        provider_id: args.providerId ?? null,
        sent_at: args.status === "sent" ? new Date().toISOString() : null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id);
  } catch (err) {
    console.error("[email] could not record outbox result", id, err);
  }
}
