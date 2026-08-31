"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertPermission } from "@/lib/server-guards";
import { logAudit } from "@/lib/audit";
import { sanitizeEmailHtml } from "@/lib/email/sanitize";
import {
  renderTemplate,
  renderAdHoc,
  renderBodyFragment,
} from "@/lib/email/render";
import { sendEmail, sendEmailBatch } from "@/lib/email/send";
import { getTemplateById, toStoredTemplate } from "@/lib/email/store";
import type { StoredTemplate } from "@/lib/email/render";
import { baseVariables, enqueueEmail } from "@/lib/email/dispatch";
import { resolveAudience, audienceAddresses, MAX_AUDIENCE } from "@/lib/email/audience";
import { isAudienceSegment } from "@/lib/email/catalog";
import { exampleValues, extractTags } from "@/lib/email/vars";
import { parseAddresses, MAX_DIRECT_RECIPIENTS } from "./shared";

/**
 * The one-off composer: send this email, to these addresses, now or later.
 *
 * The addresses are the point. Everywhere else in the admin panel a send is
 * addressed by profile id and resolved server-side, precisely so a tampered
 * request can't redirect a blast — that's the right default for bulk mail to
 * the student directory. But "email this one person who isn't in the
 * database" is a real, constant need (a parent, a sponsor, a school
 * counsellor), and routing it through a personal mailbox loses the branding,
 * the record, and the delivery metrics.
 *
 * So this accepts free-typed addresses, and pays for it with the guards a
 * free-text sender needs: an explicit permission, a hard recipient cap, one
 * audit row per send with every address in it, and no bulk personalization —
 * a hand-addressed email is written to the people it names.
 */

export type ComposeDraft = {
  /** Free-typed addresses, comma/newline separated. */
  to: string;
  /** Or an audience segment instead. */
  mode: "addresses" | "segment";
  segment: string;
  cohortId: string;
  includeParents: boolean;
  /** Start from a saved template, or write a one-off. */
  templateId: string;
  subject: string;
  bodyHtml: string;
  ctaLabel: string;
  ctaUrl: string;
  /** ISO datetime to hold it until, or "" for now. */
  scheduledFor: string;
};

export type ComposeResult =
  | { ok: true; message: string; sent: number; failed: { to: string; reason: string }[] }
  | { ok: false; error: string };

async function resolveRecipients(
  draft: ComposeDraft,
): Promise<
  | { ok: true; people: { email: string; name: string | null; userId: string | null }[] }
  | { ok: false; error: string }
> {
  if (draft.mode === "addresses") {
    const { valid, invalid } = parseAddresses(draft.to);
    if (invalid.length > 0) {
      return {
        ok: false,
        error: `These don't look like email addresses: ${invalid.slice(0, 5).join(", ")}${
          invalid.length > 5 ? `, and ${invalid.length - 5} more` : ""
        }`,
      };
    }
    if (valid.length === 0) return { ok: false, error: "Add at least one recipient." };
    if (valid.length > MAX_DIRECT_RECIPIENTS) {
      return {
        ok: false,
        error: `That's ${valid.length} addresses. Typed-in sends are capped at ${MAX_DIRECT_RECIPIENTS} — use an audience for anything bigger.`,
      };
    }

    // Match each address to a profile where one exists, so {{first_name}}
    // works for people we know without the sender having to type names.
    const admin = createAdminClient();
    const { data } = await admin
      .from("profiles")
      .select("id, email, full_name")
      .in("email", valid);
    const byEmail = new Map(
      (data ?? []).map((p: any) => [String(p.email).toLowerCase(), p]),
    );
    return {
      ok: true,
      people: valid.map((email) => {
        const p = byEmail.get(email.toLowerCase());
        return {
          email,
          name: p?.full_name ?? null,
          userId: p?.id ?? null,
        };
      }),
    };
  }

  if (!isAudienceSegment(draft.segment)) {
    return { ok: false, error: "Pick an audience." };
  }
  const members = await resolveAudience({
    segment: draft.segment,
    cohortId: draft.cohortId || null,
    includeParents: draft.includeParents,
  });
  const people = audienceAddresses(members, draft.includeParents);
  if (people.length === 0) {
    return { ok: false, error: "That audience is empty right now." };
  }
  if (people.length > MAX_AUDIENCE) {
    return { ok: false, error: `That resolves to ${people.length} addresses. Max ${MAX_AUDIENCE}.` };
  }
  return { ok: true, people };
}

/**
 * The subject and body for one recipient — from a saved template if one is
 * picked, otherwise from what's typed into the form.
 */
async function renderFor(
  draft: ComposeDraft,
  person: { email: string; name: string | null },
  /**
   * Pre-fetched template. Without it this fetched the same row once per
   * recipient — a 1000-address send issued 1000 identical SELECTs before a
   * single email left.
   */
  preloaded?: StoredTemplate | null,
) {
  const vars = baseVariables({ email: person.email, name: person.name });
  if (draft.templateId) {
    const stored = preloaded ?? (await loadStored(draft.templateId));
    if (!stored) return null;
    return renderTemplate(stored, vars);
  }
  return renderAdHoc({
    subject: draft.subject,
    bodyHtml: sanitizeEmailHtml(draft.bodyHtml),
    cta:
      draft.ctaLabel.trim() && draft.ctaUrl.trim()
        ? { label: draft.ctaLabel.trim(), url: draft.ctaUrl.trim() }
        : null,
    values: vars,
  });
}

async function loadStored(id: string): Promise<StoredTemplate | null> {
  const tpl = await getTemplateById(id);
  return tpl ? toStoredTemplate(tpl) : null;
}

function validateDraft(draft: ComposeDraft): { ok: true } | { ok: false; error: string } {
  if (!draft.templateId) {
    if (!draft.subject.trim()) return { ok: false, error: "Subject is required." };
    if (!sanitizeEmailHtml(draft.bodyHtml).replace(/<[^>]+>/g, "").trim()) {
      return { ok: false, error: "The email body can't be empty." };
    }
    const hasLabel = Boolean(draft.ctaLabel.trim());
    const hasUrl = Boolean(draft.ctaUrl.trim());
    if (hasLabel !== hasUrl) {
      return { ok: false, error: "The button needs both a label and a URL, or neither." };
    }
  }
  if (draft.scheduledFor) {
    const when = new Date(draft.scheduledFor);
    if (Number.isNaN(when.getTime())) {
      return { ok: false, error: "That send time isn't a real date." };
    }
    // A minute of slack: the browser's clock and the server's rarely agree to
    // the second, and rejecting "now" because of two seconds of drift is a
    // baffling error to receive.
    if (when.getTime() < Date.now() - 60_000) {
      return { ok: false, error: "That send time is in the past." };
    }
  }
  return { ok: true };
}

export async function previewCompose(
  draft: ComposeDraft,
): Promise<{ ok: true; html: string; subject: string } | { ok: false; error: string }> {
  await assertPermission("email.send");

  if (draft.templateId) {
    const tpl = await getTemplateById(draft.templateId);
    if (!tpl) return { ok: false, error: "That template no longer exists." };
    const stored = toStoredTemplate(tpl);
    const used = extractTags(stored.subject, stored.body_html, stored.cta_url);
    const rendered = renderTemplate(stored, {
      ...exampleValues(stored.variables ?? [], used),
      ...baseVariables({ email: "alex@example.com", name: "Alex Rivera" }),
    });
    return { ok: true, html: rendered.html, subject: rendered.subject };
  }

  const rendered = renderAdHoc({
    subject: draft.subject || "(no subject)",
    bodyHtml: sanitizeEmailHtml(draft.bodyHtml),
    cta:
      draft.ctaLabel.trim() && draft.ctaUrl.trim()
        ? { label: draft.ctaLabel.trim(), url: draft.ctaUrl.trim() }
        : null,
    values: baseVariables({ email: "alex@example.com", name: "Alex Rivera" }),
  });
  return { ok: true, html: rendered.html, subject: rendered.subject };
}

/** How many addresses the current recipient settings resolve to. */
export async function countCompose(
  draft: ComposeDraft,
): Promise<{ ok: true; count: number } | { ok: false; error: string }> {
  await assertPermission("email.send");
  const r = await resolveRecipients(draft);
  return r.ok ? { ok: true, count: r.people.length } : r;
}

export async function sendTestCompose(
  draft: ComposeDraft,
): Promise<{ ok: boolean; message: string }> {
  await assertPermission("email.send");
  const v = validateDraft(draft);
  if (!v.ok) return { ok: false, message: v.error };

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user?.email) return { ok: false, message: "No email on your account." };

  const rendered = await renderFor(draft, {
    email: user.email,
    name: user.user_metadata?.full_name ?? null,
  });
  if (!rendered) return { ok: false, message: "That template no longer exists." };

  const result = await sendEmail({
    to: user.email,
    subject: `[TEST] ${rendered.subject}`,
    html: rendered.html,
    text: rendered.text,
  });
  return result.ok
    ? { ok: true, message: `Test sent to ${user.email}.` }
    : {
        ok: false,
        message:
          result.reason === "disabled"
            ? "No email transport is configured — see email settings."
            : `Send failed: ${result.reason}`,
      };
}

export async function sendCompose(draft: ComposeDraft): Promise<ComposeResult> {
  const { userId } = await assertPermission("email.send");

  const v = validateDraft(draft);
  if (!v.ok) return { ok: false, error: v.error };

  const r = await resolveRecipients(draft);
  if (!r.ok) return { ok: false, error: r.error };
  const people = r.people;

  // ---- Scheduled: queue it and let the drainer send ----
  if (draft.scheduledFor) {
    const when = new Date(draft.scheduledFor);
    let queued = 0;
    for (const p of people) {
      // A scheduled one-off with no template behind it stores its BODY, not a
      // finished document — the shell and the merge tags are applied when it
      // sends. That keeps it editable from the outbox and lets a footer change
      // reach mail that hasn't gone yet. With a template it stores only the
      // reference, so an edit before the send time still applies.
      const id = await enqueueEmail({
        templateId: draft.templateId || null,
        to: p.email,
        toName: p.name,
        userId: p.userId,
        vars: baseVariables({ email: p.email, name: p.name }),
        sendAfter: when,
        subjectOverride: draft.templateId ? null : draft.subject.trim(),
        htmlOverride: draft.templateId
          ? null
          : // The same fragment builder the template path uses, so both
            // writers of this storage contract apply the same URL rules.
            // Hand-rolling it here put the raw draft URL straight into an href.
            renderBodyFragment({
              key: "__adhoc__",
              subject: draft.subject,
              preheader: null,
              body_html: draft.bodyHtml,
              cta_label: draft.ctaLabel.trim() || null,
              cta_url: draft.ctaUrl.trim() || null,
              variables: [],
            }),
      });
      if (id) queued++;
    }

    await logAudit({
      action: "email.compose_scheduled",
      targetType: "email_compose",
      payload: {
        mode: draft.mode,
        recipients: people.map((p) => p.email),
        count: queued,
        sendAfter: when.toISOString(),
        templateId: draft.templateId || null,
        subject: draft.subject || null,
        sender: userId,
      },
    });
    revalidatePath("/admin/email/outbox");
    return {
      ok: true,
      sent: 0,
      failed: [],
      message: `Queued ${queued} email${queued === 1 ? "" : "s"} for later. Cancel any of them from the outbox until they go.`,
    };
  }

  // ---- Immediate ----
  const items: { to: string; subject: string; html: string; text?: string }[] = [];
  const preloaded = draft.templateId ? await loadStored(draft.templateId) : null;
  if (draft.templateId && !preloaded) {
    return { ok: false, error: "That template no longer exists." };
  }
  for (const p of people) {
    const rendered = await renderFor(draft, p, preloaded);
    if (!rendered) return { ok: false, error: "That template no longer exists." };
    if (rendered.missing.length > 0) {
      return {
        ok: false,
        error: `The template needs ${rendered.missing.join(", ")}, and this send has no value for ${
          rendered.missing.length === 1 ? "it" : "them"
        }. Pick a different template or fill the gap in the copy.`,
      };
    }
    items.push({
      to: p.email,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
    });
  }

  const results = await sendEmailBatch(items);
  const failed = results
    .filter((x) => !x.ok)
    .map((x) => ({ to: x.to, reason: x.reason ?? "unknown" }));
  const sent = results.length - failed.length;

  await logAudit({
    action: "email.compose_sent",
    targetType: "email_compose",
    payload: {
      mode: draft.mode,
      // Every address, not a count. A free-text sender is exactly the tool
      // you want a full record of.
      recipients: people.map((p) => p.email),
      templateId: draft.templateId || null,
      subject: items[0]?.subject ?? null,
      sent,
      failed: failed.length,
      sender: userId,
    },
  });

  return {
    ok: true,
    sent,
    failed,
    message:
      failed.length === 0
        ? `Sent to ${sent} address${sent === 1 ? "" : "es"}.`
        : `Sent ${sent}, failed ${failed.length}.`,
  };
}
