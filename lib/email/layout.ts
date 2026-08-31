import { env } from "@/lib/env";

/**
 * The branded shell every batch0 email is wrapped in.
 *
 * Extracted from lib/email/templates.ts so the compiled templates and the
 * admin-authored ones in the database share one chrome. That sharing is the
 * point: an admin editing the acceptance email writes the *body*, and the
 * header, footer, and dark shell come from here at send time — so a template
 * saved months ago still goes out looking like the current site, and a change
 * to the footer doesn't mean re-editing every template by hand.
 */
export function emailLayout(args: {
  preheader?: string;
  body: string;
  cta?: { url: string; label: string };
  /** Small print rendered *after* the CTA. */
  footNote?: string;
  /** Appended below the footer — unsubscribe lines for bulk sends. */
  footerExtra?: string;
}) {
  const cta = args.cta
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:32px 0">
         <tr><td style="border-radius:8px;background:#ffbb00">
           <a href="${args.cta.url}" style="display:inline-block;padding:12px 22px;font-family:Inter,Arial,sans-serif;font-size:14px;font-weight:600;color:#000;text-decoration:none;border-radius:8px">
             ${args.cta.label}
           </a>
         </td></tr>
       </table>`
    : "";
  const preheader = args.preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;color:transparent">${escapeEmail(
        args.preheader,
      )}</div>`
    : "";
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0a0a0a;color:#e7e7e7;font-family:Inter,-apple-system,Arial,sans-serif">
${preheader}
<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#0a0a0a;padding:32px 16px">
  <tr><td align="center">
    <table role="presentation" cellpadding="0" cellspacing="0" width="560" style="max-width:560px;background:#111;border-radius:16px;border:1px solid rgba(255,255,255,0.08);overflow:hidden">
      <tr><td style="padding:28px 32px 16px 32px">
        <div style="font-size:18px;font-weight:700;letter-spacing:-0.01em">
          <span style="font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace">batch<span style="color:#ffbb00">0</span></span>
        </div>
      </td></tr>
      <tr><td style="padding:0 32px 32px 32px;font-size:15px;line-height:1.55;color:#e7e7e7">
        ${args.body}
        ${cta}
        ${
          args.footNote
            ? `<div style="font-size:12px;line-height:1.6;color:#888;word-break:break-all">${args.footNote}</div>`
            : ""
        }
      </td></tr>
      <tr><td style="padding:18px 32px;border-top:1px solid rgba(255,255,255,0.06);font-size:12px;color:#888">
        <a href="${env.siteUrl}" style="color:#ffbb00;text-decoration:none">${env.siteUrl.replace(/^https?:\/\//, "")}</a> · Questions?
        <a href="mailto:${env.contactEmail}" style="color:#ffbb00;text-decoration:none">${env.contactEmail}</a>${
          args.footerExtra
            ? `<div style="margin-top:10px;color:#666">${args.footerExtra}</div>`
            : ""
        }
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}

/**
 * The escaper the compiled templates use on interpolated values. Kept as-is
 * (no quote escaping) because those call sites only ever put values in text
 * position — the admin-authored path goes through lib/email/sanitize.ts,
 * which is stricter because it has to handle attribute position too.
 */
export function escapeEmail(s: string) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * CSS applied to admin-authored bodies.
 *
 * Email clients ignore stylesheets, so the renderer inlines these onto the
 * tags the rich-text editor emits rather than shipping a <style> block. A
 * contentEditable field produces bare `<p>`, `<h2>`, `<ul>` with no styling
 * of their own; without this, an admin's carefully spaced draft arrives as a
 * wall of Times New Roman.
 */
export const BODY_TAG_STYLES: Record<string, string> = {
  p: "margin:0 0 14px 0",
  h1: "margin:0 0 12px 0;font-size:22px;line-height:1.25;color:#fff;font-weight:700",
  h2: "margin:24px 0 10px 0;font-size:18px;line-height:1.3;color:#fff;font-weight:700",
  h3: "margin:20px 0 8px 0;font-size:15px;line-height:1.35;color:#fff;font-weight:700",
  ul: "margin:0 0 14px 0;padding-left:20px",
  ol: "margin:0 0 14px 0;padding-left:20px",
  li: "margin:0 0 6px 0",
  blockquote:
    "margin:16px 0;padding:12px 16px;border-left:3px solid rgba(255,255,255,0.2);color:#bbb",
  a: "color:#ffbb00;text-decoration:underline",
  hr: "border:0;border-top:1px solid rgba(255,255,255,0.1);margin:24px 0",
  code: "font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;color:#ffbb00",
  pre: "margin:0 0 14px 0;padding:12px;background:#0a0a0a;border-radius:8px;overflow-x:auto;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px",
  strong: "color:#fff",
  table: "width:100%;border-collapse:collapse;margin:0 0 14px 0",
  td: "padding:8px 10px;border:1px solid rgba(255,255,255,0.1)",
  th: "padding:8px 10px;border:1px solid rgba(255,255,255,0.1);text-align:left;color:#fff",
};

/**
 * Merge the default style for each tag with whatever the author set.
 *
 * The author's declarations come second so they win on conflict — an admin
 * who colours a paragraph red gets red, but still gets the default margin
 * they never thought about.
 */
export function applyBodyStyles(html: string): string {
  return html.replace(
    /<([a-z][a-z0-9]*)((?:\s+[^>]*)?)>/gi,
    (whole, rawTag: string, attrs: string) => {
      const tag = rawTag.toLowerCase();
      const base = BODY_TAG_STYLES[tag];
      if (!base) return whole;
      const existing = /\sstyle="([^"]*)"/i.exec(attrs);
      if (existing) {
        const merged = `${base};${existing[1]}`;
        return `<${tag}${attrs.replace(existing[0], ` style="${merged}"`)}>`;
      }
      return `<${tag}${attrs} style="${base}">`;
    },
  );
}
