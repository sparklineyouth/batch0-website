/**
 * Google Drive links: parse what people paste, keep only the parts that
 * identify the file, and rebuild every URL we render from those parts.
 *
 * Nothing a user typed ever becomes an iframe src or an href directly. A link
 * is reduced to {kind, id, resourceKey, published, gid}, each checked against
 * a strict pattern, and the open/preview URLs are rebuilt on Google's own
 * hosts. Hostnames are compared exactly after `new URL()` (never by
 * substring), so drive.google.com.evil.com and evil.com/drive.google.com fail.
 *
 * Import-free on purpose: `node --test lib/google-drive-links.test.ts` runs it
 * directly, and the same module is used by server actions and client UI.
 */

export type GoogleKind =
  | "folder"
  | "doc"
  | "sheet"
  | "slides"
  | "form"
  | "drawing"
  | "file";

export type GoogleLink = {
  kind: GoogleKind;
  id: string;
  resourceKey: string | null;
  /** A "Publish to the web" link (/d/e/<pubid>/…): read-only, no sign-in. */
  published: boolean;
  /** Sheets tab id, kept so a pinned sheet opens on the tab that was linked. */
  gid: string | null;
};

export const GOOGLE_KINDS: readonly GoogleKind[] = [
  "folder",
  "doc",
  "sheet",
  "slides",
  "form",
  "drawing",
  "file",
];

export const KIND_LABEL: Record<GoogleKind, string> = {
  folder: "Drive folder",
  doc: "Google Doc",
  sheet: "Google Sheet",
  slides: "Google Slides",
  form: "Google Form",
  drawing: "Google Drawing",
  file: "Drive file",
};

const ID = /^[A-Za-z0-9_-]{10,128}$/;
const RESOURCE_KEY = /^[A-Za-z0-9_-]{1,128}$/;
const GID = /^\d{1,12}$/;
const MAX_INPUT = 2048;
export const MAX_TITLE = 120;

/** docs.google.com path segment ↔ kind. */
const DOCS_PATH: Record<string, GoogleKind> = {
  document: "doc",
  spreadsheets: "sheet",
  presentation: "slides",
  forms: "form",
  drawings: "drawing",
};
const PATH_FOR: Partial<Record<GoogleKind, string>> = {
  doc: "document",
  sheet: "spreadsheets",
  slides: "presentation",
  form: "forms",
  drawing: "drawings",
};

/**
 * Parse a pasted URL with the given exact-host allow-list. Accepts input
 * without a scheme ("drive.google.com/…"); rejects credentials, ports,
 * non-http(s) schemes and anything over 2 KB.
 */
function parseUrl(raw: unknown, hosts: readonly string[]): URL | null {
  if (typeof raw !== "string") return null;
  let s = raw.trim();
  if (!s || s.length > MAX_INPUT) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = `https://${s}`;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (u.username || u.password || u.port) return null;
  // The WHATWG parser already lowercases and punycodes the host.
  if (!hosts.includes(u.hostname)) return null;
  return u;
}

/**
 * Parse any Google Drive / Docs URL. Returns null for anything that is not
 * an unambiguous link to one folder or file.
 *
 * `/open?id=` does not say whether the id is a file or a folder. It parses as
 * a file unless the caller is asking for a folder (`prefer: "folder"`).
 */
export function parseGoogleUrl(
  raw: unknown,
  opts: { prefer?: "folder" } = {},
): GoogleLink | null {
  const u = parseUrl(raw, ["drive.google.com", "docs.google.com"]);
  if (!u) return null;

  let segs = u.pathname.split("/").filter(Boolean);
  // Legacy Workspace prefix: /a/<domain>/…
  if (segs[0] === "a" && segs.length > 2) segs = segs.slice(2);
  // Account index: /u/<n>/ selects the viewer's signed-in account. Dropped, so
  // other viewers aren't sent to an account slot that isn't theirs.
  segs = segs.filter(
    (p, i, all) =>
      !(p === "u" && /^\d+$/.test(all[i + 1] ?? "")) &&
      !(/^\d+$/.test(p) && all[i - 1] === "u"),
  );

  const rk = u.searchParams.get("resourcekey");
  const resourceKey = rk && RESOURCE_KEY.test(rk) ? rk : null;
  const make = (
    kind: GoogleKind,
    id: string | null | undefined,
    published = false,
    gid: string | null = null,
  ): GoogleLink | null =>
    id && ID.test(id) ? { kind, id, resourceKey, published, gid } : null;
  const queryId = u.searchParams.get("id");
  const ambiguous: GoogleKind = opts.prefer === "folder" ? "folder" : "file";

  if (u.hostname === "drive.google.com") {
    if (segs[0] === "drive") {
      // /drive/folders/ID, /drive/mobile/folders/ID. /drive/my-drive,
      // /drive/shared-drives, /drive/home carry no id.
      const i = segs.indexOf("folders");
      return i >= 0 ? make("folder", segs[i + 1]) : null;
    }
    if (segs[0] === "file" && segs[1] === "d") return make("file", segs[2]);
    if (segs[0] === "folderview" || segs[0] === "embeddedfolderview") {
      return make("folder", queryId);
    }
    if (segs[0] === "open" && segs.length === 1) return make(ambiguous, queryId);
    if (segs[0] === "uc" && segs.length === 1) return make("file", queryId);
    return null;
  }

  // docs.google.com
  if (segs[0] === "file" && segs[1] === "d") return make("file", segs[2]);
  if (segs[0] === "open" && segs.length === 1) return make(ambiguous, queryId);
  const kind = DOCS_PATH[segs[0]];
  if (!kind || segs[1] !== "d") return null;
  let gid: string | null = null;
  if (kind === "sheet") {
    const fromHash = /(?:^|[#&])gid=(\d{1,12})(?:&|$)/.exec(u.hash.slice(1));
    const fromQuery = u.searchParams.get("gid");
    gid = fromHash?.[1] ?? (fromQuery && GID.test(fromQuery) ? fromQuery : null);
  }
  if (segs[2] === "e") return make(kind, segs[3], true, gid);
  return make(kind, segs[2], false, gid);
}

/**
 * Rebuild a link from a stored row, re-validating every part. Rows are
 * written only by our server actions and the table carries CHECK
 * constraints too; this is the last gate before a value reaches an iframe.
 */
export function linkFromRow(row: {
  kind: unknown;
  google_id: unknown;
  resource_key?: unknown;
  published?: unknown;
  gid?: unknown;
}): GoogleLink | null {
  const kind = row.kind as GoogleKind;
  if (!GOOGLE_KINDS.includes(kind)) return null;
  if (typeof row.google_id !== "string" || !ID.test(row.google_id)) return null;
  const rk = row.resource_key;
  if (rk != null && (typeof rk !== "string" || !RESOURCE_KEY.test(rk))) return null;
  const gid = row.gid;
  if (gid != null && (typeof gid !== "string" || !GID.test(gid))) return null;
  const published = row.published === true;
  if (published && (kind === "folder" || kind === "file")) return null;
  return {
    kind,
    id: row.google_id,
    resourceKey: (rk as string | null) ?? null,
    published,
    gid: kind === "sheet" ? ((gid as string | null) ?? null) : null,
  };
}

const rkParam = (l: GoogleLink, first: boolean) =>
  l.resourceKey ? `${first ? "?" : "&"}resourcekey=${l.resourceKey}` : "";
const gidHash = (l: GoogleLink) => (l.gid ? `#gid=${l.gid}` : "");

/** Where "Open" goes: the file in Google, in a new tab. */
export function openUrl(l: GoogleLink): string {
  if (l.kind === "folder") {
    return `https://drive.google.com/drive/folders/${l.id}${rkParam(l, true)}`;
  }
  if (l.kind === "file") {
    return `https://drive.google.com/file/d/${l.id}/view${rkParam(l, true)}`;
  }
  const path = PATH_FOR[l.kind]!;
  if (l.published) {
    const tail =
      l.kind === "form" ? "viewform" : l.kind === "sheet" ? "pubhtml" : "pub";
    return `https://docs.google.com/${path}/d/e/${l.id}/${tail}`;
  }
  return `https://docs.google.com/${path}/d/${l.id}/edit${rkParam(l, true)}${gidHash(l)}`;
}

/** The in-app preview (iframe src). Folders take a grid or list layout. */
export function embedUrl(l: GoogleLink, view: "grid" | "list" = "grid"): string {
  if (l.kind === "folder") {
    return `https://drive.google.com/embeddedfolderview?id=${l.id}${rkParam(l, false)}#${view}`;
  }
  if (l.kind === "file") {
    return `https://drive.google.com/file/d/${l.id}/preview${rkParam(l, true)}`;
  }
  const path = PATH_FOR[l.kind]!;
  if (l.published) {
    const base = `https://docs.google.com/${path}/d/e/${l.id}`;
    if (l.kind === "form") return `${base}/viewform?embedded=true`;
    if (l.kind === "slides") return `${base}/embed?start=false&loop=false`;
    if (l.kind === "sheet") return `${base}/pubhtml?widget=true&headers=false`;
    return `${base}/pub?embedded=true`;
  }
  const base = `https://docs.google.com/${path}/d/${l.id}`;
  if (l.kind === "form") return `${base}/viewform?embedded=true${rkParam(l, false)}`;
  if (l.kind === "slides") {
    return `${base}/embed?start=false&loop=false&delayms=60000${rkParam(l, false)}`;
  }
  return `${base}/preview${rkParam(l, true)}${gidHash(l)}`;
}

/**
 * A display title: control characters stripped, whitespace collapsed, capped
 * at MAX_TITLE. Empty input falls back to `fallback`.
 */
export function cleanTitle(raw: unknown, fallback: string): string {
  const s =
    typeof raw === "string"
      ? raw
          .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, " ")
          .replace(/\s+/g, " ")
          .trim()
      : "";
  return (s || fallback).slice(0, MAX_TITLE).trim() || fallback;
}

/**
 * An arbitrary https link that is safe to put in an href: https only, no
 * credentials, at most 2 KB. Returns the normalized URL or null.
 */
export function safeHttpsUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s || s.length > MAX_INPUT) return null;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  // Normalizing can grow it (spaces → %20), and the DB caps links at 2048.
  if (u.protocol !== "https:" || u.username || u.password || !u.hostname || u.href.length > MAX_INPUT) {
    return null;
  }
  return u.href;
}

export type PitchPreview = {
  provider: "google" | "youtube" | "loom";
  src: string;
};

const YT_ID = /^[A-Za-z0-9_-]{11}$/;
const LOOM_ID = /^[A-Za-z0-9]{16,64}$/;

/**
 * Inline preview for a pitch deck or video link: Google Docs/Slides/Drive,
 * YouTube or Loom. Anything else gets a plain link and no iframe.
 */
export function pitchPreview(raw: unknown): PitchPreview | null {
  const g = parseGoogleUrl(raw);
  if (g) {
    return {
      provider: "google",
      src: embedUrl(g, "list"),
    };
  }
  const yt = parseUrl(raw, [
    "youtube.com",
    "www.youtube.com",
    "m.youtube.com",
    "youtu.be",
  ]);
  if (yt) {
    const segs = yt.pathname.split("/").filter(Boolean);
    let id: string | null = null;
    if (yt.hostname === "youtu.be") id = segs[0] ?? null;
    else if (segs[0] === "watch") id = yt.searchParams.get("v");
    else if (["shorts", "embed", "live"].includes(segs[0])) id = segs[1] ?? null;
    return id && YT_ID.test(id)
      ? { provider: "youtube", src: `https://www.youtube-nocookie.com/embed/${id}` }
      : null;
  }
  const loom = parseUrl(raw, ["loom.com", "www.loom.com"]);
  if (loom) {
    const segs = loom.pathname.split("/").filter(Boolean);
    const id = segs[0] === "share" || segs[0] === "embed" ? segs[1] : null;
    return id && LOOM_ID.test(id)
      ? { provider: "loom", src: `https://www.loom.com/embed/${id}` }
      : null;
  }
  return null;
}
