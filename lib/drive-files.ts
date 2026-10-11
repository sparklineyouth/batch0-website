/**
 * Pure helpers for team-drive files: byte formatting and deciding how a
 * file can be previewed in the browser.
 *
 * Kept import-free so `node --test` can run lib/drive-files.test.ts
 * without a transpile step (same constraint as lib/live.ts).
 */

export type DrivePreviewKind =
  | "image"
  | "video"
  | "audio"
  | "pdf"
  | "text"
  | "none";

/** Hard cap on how much of a text file we pull down for the preview pane. */
export const TEXT_PREVIEW_MAX_CHARS = 200_000;

/** Largest file a member may upload to the drive. */
export const MAX_UPLOAD_BYTES = 250 * 1024 * 1024;

const IMAGE_EXTS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "avif",
  "svg",
  "bmp",
  "ico",
]);
const VIDEO_EXTS = new Set(["mp4", "webm", "ogv", "mov", "m4v"]);
const AUDIO_EXTS = new Set(["mp3", "wav", "ogg", "oga", "m4a", "aac", "flac"]);
// Rendered as plain text in a <pre>, never as markup — an .html or .svg
// file in the drive is somebody's source, not a page to execute.
const TEXT_EXTS = new Set([
  "txt",
  "md",
  "markdown",
  "csv",
  "tsv",
  "json",
  "log",
  "yml",
  "yaml",
  "toml",
  "ini",
  "env",
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "css",
  "scss",
  "html",
  "xml",
  "py",
  "rb",
  "go",
  "rs",
  "java",
  "c",
  "h",
  "cpp",
  "sh",
  "sql",
  "graphql",
]);

/** Lowercased extension without the dot, or "" when there isn't one. */
export function extOf(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return "";
  return base.slice(dot + 1).toLowerCase();
}

/**
 * How to render `file` in the preview dialog. The MIME type wins when the
 * browser gave us one at upload time; older rows (and uploads from clients
 * that sent no type) fall back to the extension.
 */
export function previewKindFor(file: {
  name: string;
  mime_type?: string | null;
}): DrivePreviewKind {
  const mime = (file.mime_type ?? "").toLowerCase().split(";")[0].trim();
  if (mime) {
    if (mime === "image/svg+xml") return "image";
    if (mime.startsWith("image/")) return "image";
    if (mime.startsWith("video/")) return "video";
    if (mime.startsWith("audio/")) return "audio";
    if (mime === "application/pdf") return "pdf";
    if (mime.startsWith("text/")) return "text";
    if (
      mime === "application/json" ||
      mime === "application/xml" ||
      mime === "application/sql" ||
      mime === "application/x-yaml"
    ) {
      return "text";
    }
    // A known binary type (zip, docx, xlsx, …) is not previewable even if
    // the extension list below would claim otherwise.
    if (mime !== "application/octet-stream") return "none";
  }
  const ext = extOf(file.name);
  if (IMAGE_EXTS.has(ext)) return "image";
  if (VIDEO_EXTS.has(ext)) return "video";
  if (AUDIO_EXTS.has(ext)) return "audio";
  if (ext === "pdf") return "pdf";
  if (TEXT_EXTS.has(ext)) return "text";
  return "none";
}

export function canPreview(file: {
  name: string;
  mime_type?: string | null;
}): boolean {
  return previewKindFor(file) !== "none";
}

/** "1.4 MB" — `null`/0 renders as an em dash, matching the rest of the UI. */
export function fmtBytes(n: number | null | undefined): string {
  if (n == null || n === 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}
