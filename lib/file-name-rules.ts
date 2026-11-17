/**
 * File-name and content-type hygiene, as pure functions over plain data.
 *
 * Why this module exists
 * ----------------------
 * These rules were written for support-ticket attachments and lived in
 * lib/support-attachment-rules.ts. They are not about support: stripping bidi
 * overrides out of a display name, deciding that `invoice.png.exe` is an
 * `exe`, and reducing a name to something a storage key can hold are the same
 * problems for every upload in this codebase. Email attachments are the second
 * caller, and copying 120 lines of security-sensitive string handling into a
 * second file is how two copies drift until only one of them strips U+202E.
 *
 * So they moved here and lib/support-attachment-rules.ts re-exports them. Its
 * public API is unchanged, every existing import still resolves, and
 * lib/support-attachment-rules.test.ts still covers this code through that
 * re-export — which is what makes the move safe to do in a feature branch.
 *
 * Zero imports, for the same reason the support module has none: a `"use
 * client"` picker has to refuse a 40 MB file before it costs anyone a round
 * trip, so nothing in here may drag a database driver into the browser bundle.
 */

/** The last path segment, for either separator. A file name is never a path. */
function baseName(name: string): string {
  const parts = name.split(/[\\/]/);
  return parts[parts.length - 1] ?? "";
}

/**
 * The final extension, lowercased, or "" when there isn't one.
 *
 * Only the LAST extension counts, because it's the one an operating system
 * acts on: `invoice.png.exe` is an `exe`. A leading dot alone (`.png`) is a
 * hidden file with no extension, and a trailing dot (`x.png.`) has none either.
 */
export function fileExtension(name: string): string {
  const base = baseName(String(name ?? "")).trim();
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return "";
  return base.slice(dot + 1).toLowerCase();
}

/** Latin diacritics off ("résumé" → "resume"); NFKD also unfolds ligatures and full-width forms. */
function asciiFold(s: string): string {
  return s.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
}

/**
 * A file name safe to use as the last segment of a storage key.
 *
 * Storage keys are a narrower alphabet than file names (Supabase refuses many
 * non-ASCII keys outright), and this name sits inside a path the server builds
 * — so it is reduced to `[a-z0-9_-]` plus the one dot before the extension:
 * no path separators, no leading dot, no `..`, at most ~90 characters. With a
 * single dot, the stored object's extension is always the extension that was
 * checked, never a fragment of the stem ("report.v2.pdf" → "report-v2.pdf").
 * It is never shown to anyone: the name a person sees and downloads as is
 * displayFileName's, kept on the row.
 */
export function safeFileName(name: string): string {
  const base = baseName(String(name ?? "")).trim();
  const rawExt = fileExtension(base);
  const ext = rawExt.replace(/[^a-z0-9]/g, "").slice(0, 10);
  const stem = rawExt ? base.slice(0, base.lastIndexOf(".")) : base;
  const clean = asciiFold(stem)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-_]+/, "")
    .slice(0, 80)
    .replace(/[-_]+$/, "");
  const out = clean || "file";
  return ext ? `${out}.${ext}` : out;
}

/**
 * Characters that change how a name is DISPLAYED without being part of it:
 * C0/C1 controls, zero-width space, BOM, and the bidi overrides. The last are
 * the dangerous ones — `photo\u202Efdp.exe` renders as "photoexe.pdf".
 * (The allow-list would refuse that `exe` anyway; this keeps the label honest.)
 */
const INVISIBLE_RE = /[\u0000-\u001f\u007f-\u009f\u200b\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

/**
 * The name a person sees on the chip and gets when they download the file.
 * Unicode is kept — "Снимок экрана.png" is a perfectly good name — but path
 * separators, invisible characters and runs of whitespace are not, and it is
 * cut to the column's 200 code points with the extension kept on the end.
 */
export function displayFileName(name: string, max: number = 200): string {
  const cleaned = baseName(String(name ?? ""))
    // Whitespace first: a tab or newline in a name separates words, so it
    // becomes a space rather than vanishing with the other control characters.
    .replace(/\s+/g, " ")
    .replace(INVISIBLE_RE, "")
    .replace(/ {2,}/g, " ")
    .trim();
  if (!cleaned) return "file";
  const chars = Array.from(cleaned);
  if (chars.length <= max) return cleaned;
  const dot = cleaned.lastIndexOf(".");
  const tail = dot > 0 && cleaned.length - dot <= 11 ? cleaned.slice(dot) : "";
  const room = max - Array.from(tail).length - 1;
  const head = Array.from(cleaned.slice(0, dot > 0 && tail ? dot : cleaned.length))
    .slice(0, room)
    .join("")
    .trimEnd();
  return `${head}…${tail}`;
}

export const UUID_SRC = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

const UUID_RE = new RegExp(`^${UUID_SRC}$`, "i");

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

/**
 * Active content a browser would execute if someone opened the file directly.
 * The challenge-upload list (app/challenges/[slug]/actions.ts BLOCKED_MIME)
 * plus XML, which can carry an XHTML namespace and script. None of these can
 * come from an allowed extension honestly, so a match means a tampered upload.
 */
const BLOCKED_TYPE_RE =
  /^(text\/html|application\/xhtml\+xml|image\/svg\+xml|application\/(x-)?javascript|text\/javascript|application\/xml|text\/xml)/i;

export function isBlockedContentType(type: string | null | undefined): boolean {
  return BLOCKED_TYPE_RE.test(String(type ?? "").trim());
}

/** What goes in `content_type`: storage's word for it, tidied, never empty. */
export function normalizeContentType(
  type: string | null | undefined,
  max: number = 200,
): string {
  const t = String(type ?? "").trim().toLowerCase().slice(0, max);
  return t || "application/octet-stream";
}

function trimZero(fixed: string): string {
  return fixed.endsWith(".0") ? fixed.slice(0, -2) : fixed;
}

/** Human size for a chip — "820 KB", "2.4 MB". "" for anything that isn't a size. */
export function formatBytes(bytes: number | null | undefined): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const text = value < 100 ? trimZero(value.toFixed(1)) : String(Math.round(value));
  // 1,023.96 KB rounds to "1024 KB" — that's "1 MB".
  if (Number(text) >= 1024 && unit < units.length - 1) return `1 ${units[unit + 1]}`;
  return `${text} ${units[unit]}`;
}
