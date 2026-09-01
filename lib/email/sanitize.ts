/**
 * HTML sanitizer for admin-authored email bodies.
 *
 * The rich-text editor at /admin/email/templates writes HTML, and it also
 * offers a raw-source tab — so the body arriving at the server is untrusted
 * markup from a browser, not a value the editor is guaranteed to have shaped.
 * Anything that reaches the database has been through here.
 *
 * This is an *allowlist*: unknown tags are unwrapped (their text survives,
 * the tag doesn't) and unknown attributes are dropped. Denylists lose to the
 * next encoding trick someone finds; an allowlist only ever fails closed.
 *
 * Why hand-rolled rather than a library: this runs on the server *and* the
 * output must be email-safe HTML, which is a much smaller grammar than web
 * HTML — no scripts, no forms, no media, no CSS classes, inline styles only
 * from a fixed set of properties. A general-purpose sanitizer configured
 * down to this subset is more configuration than code, and it would still
 * need the `javascript:` URL and `{{tag}}`-preservation rules below.
 *
 * Deliberately import-free — `npm test` runs it directly through Node's type
 * stripping, and the editor imports it client-side for its source tab.
 */

/** Tags that survive, mapped to the attributes each may keep. */
const ALLOWED: Record<string, readonly string[]> = {
  p: ["style"],
  br: [],
  strong: [],
  b: [],
  em: [],
  i: [],
  u: [],
  s: [],
  h1: ["style"],
  h2: ["style"],
  h3: ["style"],
  ul: ["style"],
  ol: ["style"],
  li: ["style"],
  blockquote: ["style"],
  a: ["href", "style", "target", "rel", "title"],
  img: ["src", "alt", "width", "height", "style"],
  hr: ["style"],
  span: ["style"],
  div: ["style"],
  table: ["style", "width", "cellpadding", "cellspacing", "role", "align"],
  thead: ["style"],
  tbody: ["style"],
  tr: ["style"],
  td: ["style", "align", "valign", "colspan", "width"],
  th: ["style", "align", "valign", "colspan", "width"],
  code: ["style"],
  pre: ["style"],
};

/** Void elements — no closing tag, and nothing to unwrap. */
const VOID = new Set(["br", "img", "hr"]);

/**
 * Tags whose *content* is dropped along with the tag. Unwrapping a `<script>`
 * would paste its source into the email as visible text, which is worse than
 * losing it.
 */
const STRIP_CONTENT = new Set([
  "script",
  "style",
  "iframe",
  "object",
  "embed",
  "form",
  "input",
  "button",
  "select",
  "textarea",
  "noscript",
  "svg",
  "math",
  "link",
  "meta",
  "title",
  "head",
]);

/**
 * Inline CSS properties an admin may set. Everything layout-ish is here
 * because email clients need inline styles, but nothing that can load a
 * resource or escape the frame: no `position`, no `behavior`, no `url()`.
 */
const ALLOWED_STYLE_PROPS = new Set([
  "color",
  "background",
  "background-color",
  "font-size",
  "font-weight",
  "font-style",
  "font-family",
  "text-align",
  "text-decoration",
  "line-height",
  "letter-spacing",
  "margin",
  "margin-top",
  "margin-bottom",
  "margin-left",
  "margin-right",
  "padding",
  "padding-top",
  "padding-bottom",
  "padding-left",
  "padding-right",
  "border",
  "border-top",
  "border-bottom",
  "border-left",
  "border-right",
  "border-radius",
  "border-color",
  "width",
  "max-width",
  "height",
  "display",
  "vertical-align",
  "white-space",
  "opacity",
]);

/**
 * A URL is safe if it is http(s), mailto, a fragment, or a merge tag that
 * will *become* one of those at render time.
 *
 * `javascript:` is the obvious case, but the one that actually bites is
 * `&#106;avascript:` and friends — HTML entities are decoded by the client
 * after we've stored the string, so the check has to happen on the decoded
 * value. Whitespace and control characters are stripped first for the same
 * reason: `java\nscript:` is a working URL in more clients than you'd hope.
 */
export function isSafeUrl(raw: string): boolean {
  // Strip C0 controls, space, and DEL before the scheme test: a tab or
  // newline inside "java\tscript:" is ignored by more clients than you would
  // hope, so the check has to run on the collapsed value.
  const decoded = decodeEntities(raw).replace(/[\u0000-\u0020\u007f]/g, "");
  if (decoded === "") return false;
  // A URL that is entirely a merge tag is resolved (and re-checked) at render.
  if (/^\{\{[a-zA-Z0-9_.]+\}\}/.test(decoded)) return true;
  if (/^(https?:|mailto:|tel:)/i.test(decoded)) return true;
  // Relative and fragment links.
  if (/^[#/]/.test(decoded)) return true;
  // No scheme at all (e.g. "batch0.org/apply") — safe, resolved at render.
  return !/^[a-z][a-z0-9+.-]*:/i.test(decoded);
}

/** Decode the entity forms that matter for scheme smuggling. */
function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);?/gi, (_, h) =>
      safeFromCodePoint(parseInt(h, 16)),
    )
    .replace(/&#(\d+);?/g, (_, d) => safeFromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/gi, "&")
    .replace(/&colon;/gi, ":")
    .replace(/&tab;/gi, "\t")
    .replace(/&newline;/gi, "\n");
}

function safeFromCodePoint(n: number): string {
  return Number.isFinite(n) && n >= 0 && n <= 0x10ffff
    ? String.fromCodePoint(n)
    : "";
}

function sanitizeStyle(value: string): string {
  const out: string[] = [];
  for (const decl of decodeEntities(value).split(";")) {
    const idx = decl.indexOf(":");
    if (idx < 0) continue;
    const prop = decl.slice(0, idx).trim().toLowerCase();
    const val = decl.slice(idx + 1).trim();
    if (!ALLOWED_STYLE_PROPS.has(prop)) continue;
    // `url(...)` pulls a remote resource (tracking pixel, or worse in older
    // clients) and `expression(...)` is executable in legacy Outlook.
    if (/url\s*\(|expression\s*\(|[<>]/i.test(val)) continue;
    if (val === "") continue;
    out.push(`${prop}:${val}`);
  }
  return out.join(";");
}

/** Escape a value for use inside a double-quoted attribute. */
function escapeAttr(v: string): string {
  return v
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Escape text content. Quotes are left alone — they're legal in text. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

const ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*("[^"]*"|'[^']*'|[^\s"'>=`]+))?/g;

function sanitizeAttributes(tag: string, rawAttrs: string): string {
  const allowed = ALLOWED[tag];
  const out: string[] = [];
  let m: RegExpExecArray | null;
  ATTR_RE.lastIndex = 0;
  while ((m = ATTR_RE.exec(rawAttrs))) {
    const name = m[1].toLowerCase();
    if (!allowed.includes(name)) continue;
    let value = m[2] ?? "";
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (name === "style") {
      const style = sanitizeStyle(value);
      if (style) out.push(`style="${escapeAttr(style)}"`);
      continue;
    }
    if (name === "href" || name === "src") {
      if (!isSafeUrl(value)) continue;
      out.push(`${name}="${escapeAttr(value.trim())}"`);
      continue;
    }
    if (name === "target") {
      // Only _blank is useful in email, and it must carry the noopener pair.
      if (value !== "_blank") continue;
      out.push('target="_blank"');
      continue;
    }
    out.push(`${name}="${escapeAttr(value)}"`);
  }
  // An external link that opens in a new tab leaks the opener without this.
  if (tag === "a") {
    const hasTarget = out.some((a) => a.startsWith("target="));
    const relIdx = out.findIndex((a) => a.startsWith("rel="));
    if (hasTarget) {
      if (relIdx >= 0) out[relIdx] = 'rel="noopener noreferrer"';
      else out.push('rel="noopener noreferrer"');
    }
  }
  return out.length ? " " + out.join(" ") : "";
}

const TOKEN_RE = /<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>/g;

/**
 * Sanitize an admin-authored HTML fragment down to the email-safe subset.
 *
 * Returns a fragment, not a document — the renderer wraps it in the branded
 * layout. `{{merge_tags}}` pass through untouched so interpolation still has
 * something to substitute.
 */
export function sanitizeEmailHtml(input: string): string {
  if (!input) return "";
  let out = "";
  let last = 0;
  // Tags we opened and must close, so unbalanced input can't leak markup
  // into the layout that wraps this fragment.
  const open: string[] = [];
  // When we hit <script> et al we skip everything until its close tag.
  let skipUntil: string | null = null;

  let m: RegExpExecArray | null;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(input))) {
    const text = input.slice(last, m.index);
    last = TOKEN_RE.lastIndex;
    if (!skipUntil) out += escapeHtml(text);

    const token = m[0];
    // Comments, doctypes, CDATA — dropped entirely. Conditional comments are
    // how Outlook-specific markup smuggles itself in.
    if (!m[1]) continue;

    const tag = m[1].toLowerCase();
    const closing = token.startsWith("</");

    if (skipUntil) {
      if (closing && tag === skipUntil) skipUntil = null;
      continue;
    }
    if (STRIP_CONTENT.has(tag)) {
      if (!closing && !token.endsWith("/>")) skipUntil = tag;
      continue;
    }
    if (!(tag in ALLOWED)) continue; // unwrap: keep the text, drop the tag

    if (closing) {
      // Close back to the matching open tag; ignore a stray close.
      const idx = open.lastIndexOf(tag);
      if (idx < 0) continue;
      for (let i = open.length - 1; i >= idx; i--) out += `</${open[i]}>`;
      open.length = idx;
      continue;
    }
    if (VOID.has(tag)) {
      out += `<${tag}${sanitizeAttributes(tag, m[2] ?? "")}>`;
      continue;
    }
    out += `<${tag}${sanitizeAttributes(tag, m[2] ?? "")}>`;
    open.push(tag);
  }
  if (!skipUntil) out += escapeHtml(input.slice(last));
  for (let i = open.length - 1; i >= 0; i--) out += `</${open[i]}>`;
  return out;
}

/**
 * A plain-text version of a sanitized body, for the `text/plain` part.
 *
 * Some clients (and most spam filters) prefer a multipart message, and a
 * missing text part is a small but real deliverability cost. Block-level tags
 * become newlines, links keep their target in parentheses, everything else is
 * unwrapped.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\s*hr\s*\/?\s*>/gi, "\n---\n")
    .replace(/<\s*li[^>]*>/gi, "\n• ")
    .replace(
      /<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi,
      (_, href, label) => {
        const text = label.replace(/<[^>]+>/g, "").trim();
        return text && text !== href ? `${text} (${href})` : href;
      },
    )
    .replace(/<\/\s*(p|div|h1|h2|h3|ul|ol|blockquote|tr|table|pre)\s*>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
