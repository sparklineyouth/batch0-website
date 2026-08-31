"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertPermission } from "@/lib/server-guards";
import { logAudit } from "@/lib/audit";
import { sanitizeEmailHtml, isSafeUrl } from "@/lib/email/sanitize";
import { renderPreview, renderTemplate } from "@/lib/email/render";
import { sendEmail } from "@/lib/email/send";
import { seedSystemTemplates } from "@/lib/email/seed";
import { getTemplateById } from "@/lib/email/store";
import { baseVariables } from "@/lib/email/dispatch";
import {
  isTemplateCategory,
  slugifyTemplateKey,
  TEMPLATE_KEY_PATTERN,
} from "@/lib/email/catalog";
import {
  isValidVariableKey,
  extractTags,
  exampleValues,
  type VariableDef,
} from "@/lib/email/vars";

/**
 * Template CRUD.
 *
 * Two things every action here has in common, and both are load-bearing:
 *
 *  - the body is sanitized *server-side* before it's stored. The editor
 *    sanitizes too, but that's a convenience for the admin — the browser is
 *    not a place to enforce anything, and the source tab hands us raw HTML by
 *    design.
 *  - a save snapshots the previous content into `email_template_versions`
 *    first. Email copy gets edited live and in a hurry; an undo is the
 *    difference between a bad edit being a two-second fix and a two-hour one.
 */

export type TemplateInput = {
  id?: string;
  key: string;
  name: string;
  description: string;
  category: string;
  subject: string;
  preheader: string;
  bodyHtml: string;
  ctaLabel: string;
  ctaUrl: string;
  fromName: string;
  fromEmail: string;
  replyTo: string;
  variables: VariableDef[];
  enabled: boolean;
};

export type SaveResult =
  | { ok: true; id: string; key: string }
  | { ok: false; error: string };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validate(
  input: TemplateInput,
): { ok: true; clean: Required<TemplateInput> } | { ok: false; error: string } {
  const name = input.name.trim();
  if (!name) return { ok: false, error: "Give the template a name." };

  const key = slugifyTemplateKey(input.key || input.name);
  if (!TEMPLATE_KEY_PATTERN.test(key)) {
    return {
      ok: false,
      error:
        "The key must be lowercase letters, numbers, and underscores, optionally dotted (e.g. application.accepted).",
    };
  }

  const subject = input.subject.trim();
  if (!subject) return { ok: false, error: "Subject is required." };

  const bodyHtml = sanitizeEmailHtml(input.bodyHtml ?? "");
  if (!bodyHtml.replace(/<[^>]+>/g, "").trim()) {
    return { ok: false, error: "The email body can't be empty." };
  }

  if (!isTemplateCategory(input.category)) {
    return { ok: false, error: "Unknown category." };
  }

  const ctaLabel = input.ctaLabel.trim();
  const ctaUrl = input.ctaUrl.trim();
  if ((ctaLabel && !ctaUrl) || (!ctaLabel && ctaUrl)) {
    return {
      ok: false,
      error: "The button needs both a label and a URL, or neither.",
    };
  }
  if (ctaUrl && !isSafeUrl(ctaUrl)) {
    return { ok: false, error: "That button URL isn't a valid link." };
  }

  const fromEmail = input.fromEmail.trim();
  if (fromEmail && !EMAIL_RE.test(fromEmail)) {
    return { ok: false, error: "The From address isn't a valid email." };
  }
  const replyTo = input.replyTo.trim();
  if (replyTo && !EMAIL_RE.test(replyTo)) {
    return { ok: false, error: "The Reply-to address isn't a valid email." };
  }

  const seen = new Set<string>();
  const variables: VariableDef[] = [];
  for (const v of input.variables ?? []) {
    const vk = v.key?.trim();
    if (!vk) continue;
    if (!isValidVariableKey(vk)) {
      return {
        ok: false,
        error: `"${vk}" isn't a usable variable name — letters, numbers, underscores and dots only.`,
      };
    }
    if (seen.has(vk)) {
      return { ok: false, error: `The variable "${vk}" is listed twice.` };
    }
    seen.add(vk);
    variables.push({
      key: vk,
      label: (v.label ?? "").trim() || vk,
      example: (v.example ?? "").trim(),
      required: Boolean(v.required),
    });
  }

  return {
    ok: true,
    clean: {
      id: input.id ?? "",
      key,
      name,
      description: input.description.trim(),
      category: input.category,
      subject,
      preheader: input.preheader.trim(),
      bodyHtml,
      ctaLabel,
      ctaUrl,
      fromName: input.fromName.trim(),
      fromEmail,
      replyTo,
      variables,
      enabled: input.enabled,
    },
  };
}

export async function saveTemplate(input: TemplateInput): Promise<SaveResult> {
  const { userId } = await assertPermission("email.templates");
  const v = validate(input);
  if (!v.ok) return v;
  const c = v.clean;
  const admin = createAdminClient();

  const row = {
    name: c.name,
    description: c.description || null,
    category: c.category,
    subject: c.subject,
    preheader: c.preheader || null,
    body_html: c.bodyHtml,
    cta_label: c.ctaLabel || null,
    cta_url: c.ctaUrl || null,
    from_name: c.fromName || null,
    from_email: c.fromEmail || null,
    reply_to: c.replyTo || null,
    variables: c.variables,
    enabled: c.enabled,
    updated_by: userId,
  };

  if (input.id) {
    const existing = await getTemplateById(input.id);
    if (!existing) return { ok: false, error: "That template no longer exists." };

    // Snapshot before overwriting. Written first on purpose: if the update
    // fails we've kept a redundant version row, which costs nothing. If the
    // snapshot failed after a successful update we'd have lost the undo.
    await admin.from("email_template_versions").insert({
      template_id: existing.id,
      version: existing.version,
      subject: existing.subject,
      preheader: existing.preheader,
      body_html: existing.body_html,
      cta_label: existing.cta_label,
      cta_url: existing.cta_url,
      variables: existing.variables ?? [],
      edited_by: userId,
    });

    const { error } = await admin
      .from("email_templates")
      .update({
        ...row,
        // A system template's key is what a call site passes; the database
        // trigger refuses the change anyway, but not sending it keeps the
        // error out of the admin's face for a field they can't edit.
        ...(existing.is_system ? {} : { key: c.key }),
        version: existing.version + 1,
      })
      .eq("id", input.id);
    if (error) return { ok: false, error: error.message };

    await logAudit({
      action: "email.template_updated",
      targetType: "email_template",
      targetId: input.id,
      payload: { key: existing.key, name: c.name, version: existing.version + 1 },
    });
    revalidateTemplates(input.id);
    return { ok: true, id: input.id, key: existing.key };
  }

  const { data, error } = await admin
    .from("email_templates")
    .insert({ ...row, key: c.key, is_system: false, created_by: userId })
    .select("id")
    .single();
  if (error) {
    if ((error as any).code === "23505") {
      return { ok: false, error: `A template with the key "${c.key}" already exists.` };
    }
    return { ok: false, error: error.message };
  }

  await logAudit({
    action: "email.template_created",
    targetType: "email_template",
    targetId: data.id,
    payload: { key: c.key, name: c.name },
  });
  revalidateTemplates(data.id);
  return { ok: true, id: data.id, key: c.key };
}

function revalidateTemplates(id?: string) {
  revalidatePath("/admin/email/templates");
  if (id) revalidatePath(`/admin/email/templates/${id}`);
  revalidatePath("/admin/email/automations");
}

export async function deleteTemplate(
  id: string,
): Promise<{ ok: boolean; error?: string }> {
  await assertPermission("email.templates");
  const admin = createAdminClient();

  const existing = await getTemplateById(id);
  if (!existing) return { ok: true };
  if (existing.is_system) {
    return {
      ok: false,
      error:
        "This is a built-in template that the app sends by name. Disable it instead — the original copy takes over.",
    };
  }

  // A template referenced by an automation step can't go: the step would
  // point at nothing, and the failure would show up as an email that quietly
  // never arrives.
  const { count } = await admin
    .from("email_automation_steps")
    .select("id", { count: "exact", head: true })
    .eq("template_id", id);
  if ((count ?? 0) > 0) {
    return {
      ok: false,
      error: `${count} automation step${count === 1 ? "" : "s"} still use this template. Remove those first.`,
    };
  }

  const { error } = await admin.from("email_templates").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };

  await logAudit({
    action: "email.template_deleted",
    targetType: "email_template",
    targetId: id,
    payload: { key: existing.key, name: existing.name },
  });
  revalidateTemplates();
  return { ok: true };
}

export async function setTemplateEnabled(
  id: string,
  enabled: boolean,
): Promise<{ ok: boolean; error?: string }> {
  const { userId } = await assertPermission("email.templates");
  const admin = createAdminClient();
  const { error } = await admin
    .from("email_templates")
    .update({ enabled, updated_by: userId })
    .eq("id", id);
  if (error) return { ok: false, error: error.message };
  await logAudit({
    action: enabled ? "email.template_enabled" : "email.template_disabled",
    targetType: "email_template",
    targetId: id,
  });
  revalidateTemplates(id);
  return { ok: true };
}

/** Render with sample data for the live preview pane. */
export async function previewTemplate(
  input: TemplateInput,
): Promise<{ ok: true; html: string; subject: string } | { ok: false; error: string }> {
  await assertPermission("email.templates");
  const rendered = renderPreview({
    key: input.key || "preview",
    subject: input.subject || "(no subject)",
    preheader: input.preheader || null,
    body_html: sanitizeEmailHtml(input.bodyHtml ?? ""),
    cta_label: input.ctaLabel || null,
    cta_url: input.ctaUrl || null,
    variables: input.variables ?? [],
  });
  return { ok: true, html: rendered.html, subject: rendered.subject };
}

/**
 * Send the draft to the signed-in admin.
 *
 * A real send through the real transport, not a simulation — the failures
 * worth catching (an unverified sender, a dead SMTP credential, a client that
 * mangles the layout) are exactly the ones a rendered preview can't show.
 */
export async function sendTestTemplate(
  input: TemplateInput,
  toOverride?: string,
): Promise<{ ok: boolean; message: string }> {
  await assertPermission("email.templates");

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const to = (toOverride ?? "").trim() || user?.email;
  if (!to) return { ok: false, message: "No address to send the test to." };
  if (!EMAIL_RE.test(to)) return { ok: false, message: `"${to}" isn't a valid email.` };

  const v = validate(input);
  if (!v.ok) return { ok: false, message: v.error };
  const c = v.clean;

  const used = extractTags(c.subject, c.preheader, c.bodyHtml, c.ctaUrl);
  const rendered = renderTemplate(
    {
      key: c.key,
      subject: c.subject,
      preheader: c.preheader || null,
      body_html: c.bodyHtml,
      cta_label: c.ctaLabel || null,
      cta_url: c.ctaUrl || null,
      variables: c.variables,
    },
    {
      // Sample values, then the tester's own details on top — seeing your own
      // name in the greeting is what makes a test send tell you the
      // personalization works.
      ...exampleValues(c.variables, used),
      ...baseVariables({ email: to, name: user?.user_metadata?.full_name ?? null }),
    },
    { footerExtra: "Test send from /admin/email/templates." },
  );

  const result = await sendEmail({
    to,
    subject: `[TEST] ${rendered.subject}`,
    html: rendered.html,
    text: rendered.text,
    templateKey: c.key,
  });

  if (result.ok) return { ok: true, message: `Test sent to ${to}.` };
  return {
    ok: false,
    message:
      result.reason === "disabled"
        ? "No email transport is configured. Set RESEND_API_KEY, or connect a mailbox at /admin/email/settings."
        : `Send failed: ${result.reason}`,
  };
}

/** Roll a template back to one of its stored versions. */
export async function restoreTemplateVersion(
  templateId: string,
  versionId: string,
): Promise<{ ok: boolean; error?: string }> {
  const { userId } = await assertPermission("email.templates");
  const admin = createAdminClient();

  const [{ data: version }, current] = await Promise.all([
    admin
      .from("email_template_versions")
      .select("*")
      .eq("id", versionId)
      .eq("template_id", templateId)
      .maybeSingle(),
    getTemplateById(templateId),
  ]);
  if (!version || !current) return { ok: false, error: "That version is gone." };

  // Snapshot the current state before restoring, so a restore is itself
  // undoable — otherwise "roll back" is a one-way door and nobody dares use it.
  await admin.from("email_template_versions").insert({
    template_id: templateId,
    version: current.version,
    subject: current.subject,
    preheader: current.preheader,
    body_html: current.body_html,
    cta_label: current.cta_label,
    cta_url: current.cta_url,
    variables: current.variables ?? [],
    edited_by: userId,
  });

  const { error } = await admin
    .from("email_templates")
    .update({
      subject: (version as any).subject,
      preheader: (version as any).preheader,
      body_html: sanitizeEmailHtml((version as any).body_html ?? ""),
      cta_label: (version as any).cta_label,
      cta_url: (version as any).cta_url,
      variables: (version as any).variables ?? [],
      version: current.version + 1,
      updated_by: userId,
    })
    .eq("id", templateId);
  if (error) return { ok: false, error: error.message };

  await logAudit({
    action: "email.template_restored",
    targetType: "email_template",
    targetId: templateId,
    payload: { key: current.key, restoredFrom: (version as any).version },
  });
  revalidateTemplates(templateId);
  return { ok: true };
}

/** Create rows for any built-in template that doesn't have one yet. */
export async function restoreBuiltInTemplates(): Promise<{
  ok: boolean;
  message: string;
}> {
  const { userId } = await assertPermission("email.templates");
  const report = await seedSystemTemplates(userId);
  if (report.error) return { ok: false, message: report.error };

  if (report.inserted.length > 0) {
    await logAudit({
      action: "email.templates_seeded",
      targetType: "email_template",
      payload: { inserted: report.inserted },
    });
  }
  revalidateTemplates();
  return {
    ok: true,
    message:
      report.inserted.length === 0
        ? "All built-in templates are already here."
        : `Added ${report.inserted.length} built-in template${report.inserted.length === 1 ? "" : "s"}.`,
  };
}

/** Copy an existing template into a new, editable one. */
export async function duplicateTemplate(
  id: string,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const { userId } = await assertPermission("email.templates");
  const source = await getTemplateById(id);
  if (!source) return { ok: false, error: "That template no longer exists." };

  const admin = createAdminClient();
  // Find a free key rather than failing on the unique index — an admin
  // duplicating twice shouldn't have to invent a name before they can start.
  let key = `${source.key}_copy`;
  for (let n = 2; n < 50; n++) {
    const { data: clash } = await admin
      .from("email_templates")
      .select("id")
      .eq("key", key)
      .maybeSingle();
    if (!clash) break;
    key = `${source.key}_copy_${n}`;
  }

  const { data, error } = await admin
    .from("email_templates")
    .insert({
      key,
      name: `${source.name} (copy)`,
      description: source.description,
      category: source.category,
      subject: source.subject,
      preheader: source.preheader,
      body_html: source.body_html,
      cta_label: source.cta_label,
      cta_url: source.cta_url,
      from_name: source.from_name,
      from_email: source.from_email,
      reply_to: source.reply_to,
      variables: source.variables ?? [],
      is_system: false,
      enabled: false,
      created_by: userId,
      updated_by: userId,
    })
    .select("id")
    .single();
  if (error) return { ok: false, error: error.message };

  revalidateTemplates();
  return { ok: true, id: data.id };
}
