import { emailLayout, applyBodyStyles } from "@/lib/email/layout";
import { sanitizeEmailHtml, htmlToText, isSafeUrl } from "@/lib/email/sanitize";
import {
  interpolate,
  extractTags,
  exampleValues,
  missingRequired,
  type VariableDef,
  type VariableValues,
} from "@/lib/email/vars";

/**
 * Turn a stored template row into a sendable email.
 *
 * The order of operations here is load-bearing and easy to get subtly wrong:
 *
 *   sanitize → interpolate → style → wrap
 *
 * Sanitizing *before* interpolation means the merge values are never seen by
 * the sanitizer, which is correct — they're data, not markup, and they get
 * HTML-escaped by the interpolator instead. Doing it the other way round
 * would let a display name of `<b>` change the email's markup, and a display
 * name is whatever someone typed into a signup form.
 *
 * The stored body is re-sanitized on every render even though it was already
 * sanitized on save. Cheap, and it means a row written before a rule was
 * tightened (or by a future code path that forgot) still can't ship markup we
 * don't allow.
 */

export type StoredTemplate = {
  id?: string;
  key: string;
  subject: string;
  preheader: string | null;
  body_html: string;
  cta_label: string | null;
  cta_url: string | null;
  variables: VariableDef[] | null;
  from_name?: string | null;
  from_email?: string | null;
  reply_to?: string | null;
};

export type RenderedEmail = {
  subject: string;
  html: string;
  text: string;
  /** Declared-required tags with no value. Non-empty means: don't send. */
  missing: string[];
};

export type RenderOptions = {
  /**
   * Appended inside the footer. Bulk sends pass an unsubscribe line here;
   * transactional ones don't, because an unsubscribe link on a password reset
   * is both wrong and, for the person who clicks it, quietly destructive.
   */
  footerExtra?: string;
};

export function renderTemplate(
  template: StoredTemplate,
  values: VariableValues,
  opts: RenderOptions = {},
): RenderedEmail {
  const declared = template.variables ?? [];

  // Subject and preheader are plain text in the client's chrome, so they're
  // interpolated unescaped — escaping there would show a literal `&amp;` in
  // the inbox list, which is the one place a stray entity is unmissable.
  const subject = interpolate(template.subject ?? "", values, {
    escape: false,
  }).trim();
  const preheader = template.preheader
    ? interpolate(template.preheader, values, { escape: false }).trim()
    : undefined;

  const safeBody = sanitizeEmailHtml(template.body_html ?? "");
  const body = applyBodyStyles(interpolate(safeBody, values, { escape: true }));

  const cta = resolveCta(template, values);

  const html = emailLayout({
    preheader: preheader || subject,
    body,
    cta: cta ?? undefined,
    footerExtra: opts.footerExtra,
  });

  return {
    subject,
    html,
    text: htmlToText(body) + (cta ? `\n\n${cta.label}: ${cta.url}` : ""),
    missing: missingRequired(declared, values),
  };
}

/**
 * The CTA button, if the template has a usable one.
 *
 * A button whose URL is a merge tag that didn't resolve would render as a
 * link to the literal string `{{pay_url}}` — a dead button in a live email,
 * and the single worst failure mode in the whole system because the recipient
 * can see it and can't act on it. Dropping the button loses the click; a
 * broken button loses the trust. So an unresolved or unsafe URL removes the
 * button entirely rather than shipping it.
 */
function resolveCta(
  template: StoredTemplate,
  values: VariableValues,
): { url: string; label: string } | null {
  const label = template.cta_label?.trim();
  const rawUrl = template.cta_url?.trim();
  if (!label || !rawUrl) return null;
  const url = interpolate(rawUrl, values, { escape: false }).trim();
  if (/\{\{/.test(url)) return null;
  if (!isSafeUrl(url) || !/^(https?:|mailto:)/i.test(url)) return null;
  return {
    url: url.replace(/"/g, "%22"),
    label: interpolate(label, values, { escape: true }),
  };
}

/**
 * Render with sample data for the editor's preview pane.
 *
 * Falls back to an example for every tag the body uses, declared or not, so
 * the preview always shows finished copy — an admin judging line breaks and
 * spacing shouldn't have to read around raw `{{braces}}`.
 */
export function renderPreview(
  template: StoredTemplate,
  overrides: VariableValues = {},
): RenderedEmail {
  const used = extractTags(
    template.subject,
    template.preheader,
    template.body_html,
    template.cta_url,
    template.cta_label,
  );
  const values = {
    ...exampleValues(template.variables ?? [], used),
    ...overrides,
  };
  return renderTemplate(template, values, {
    footerExtra: "You're seeing a preview — this copy hasn't been sent.",
  });
}

/**
 * Wrap a plain-HTML fragment in the shell without a template behind it. Used
 * by the one-off composer at /admin/email/compose, where there's copy to send
 * but nothing worth saving.
 */
export function renderAdHoc(args: {
  subject: string;
  bodyHtml: string;
  cta?: { url: string; label: string } | null;
  values?: VariableValues;
  footerExtra?: string;
}): RenderedEmail {
  return renderTemplate(
    {
      key: "__adhoc__",
      subject: args.subject,
      preheader: null,
      body_html: args.bodyHtml,
      cta_label: args.cta?.label ?? null,
      cta_url: args.cta?.url ?? null,
      variables: [],
    },
    args.values ?? {},
    { footerExtra: args.footerExtra },
  );
}

/**
 * The interpolated body of a template as an editable HTML *fragment*, with the
 * CTA folded in as a link.
 *
 * This is what "freeze this template onto one queued email" produces. It has
 * to be a fragment rather than the finished document, because the admin then
 * edits it in the rich-text editor — handing that editor a full
 * `<!doctype html>` page would be unusable, and re-wrapping an already-wrapped
 * document on the next save would nest the branded shell inside itself.
 *
 * Deliberately keeps the merge tags UNRESOLVED where the caller passes no
 * value, so a frozen email still personalises at send time.
 */
export function renderBodyFragment(
  template: StoredTemplate,
  values: VariableValues = {},
): string {
  const body = interpolate(
    sanitizeEmailHtml(template.body_html ?? ""),
    values,
    { escape: true },
  );
  const cta = resolveCta(template, values);
  if (!cta) return body;
  return `${body}<p><a href="${cta.url}">${cta.label}</a></p>`;
}
