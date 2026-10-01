import { Download, FileText, Film, ImageIcon, NotebookPen } from "lucide-react";
import {
  attachmentHref,
  attachmentKind,
  formatBytes,
  opensInline,
  type AttachmentAccess,
  type SupportAttachment,
} from "@/lib/support-attachment-rules";

/**
 * The files on one message, as chips: an icon (a thumbnail for an image), the
 * name, the size, and a link that opens or downloads it.
 *
 * Server-safe and hook-free, so it renders from a server page and from inside
 * the client thread components alike — it imports only the dependency-free
 * rules module, never lib/support-attachments.ts.
 *
 * Every link goes through a download route that re-authorizes the click
 * (`access` picks which): /support/files/<id> for a signed-in page,
 * /support/t/<token>/files/<id> for the emailed-link page. Never a storage
 * URL, so the page holds nothing that works once copied off it. Plain <a>,
 * never next/link — these are route handlers, and a token URL must never ride
 * a client-side navigation (it would reach analytics as a page view). Thumbnails
 * load through the same route, so they're re-authorized too.
 *
 * Images open in a new tab; everything else downloads under its own name (the
 * route sets that up). Internal files — staff-only — are marked the way the
 * thread marks an internal note.
 */
export function AttachmentList({
  items,
  access,
  compact = false,
}: {
  items: SupportAttachment[];
  access: AttachmentAccess;
  /** The phone layout for the installed app: full-width rows, bigger targets. */
  compact?: boolean;
}) {
  // A token page is the requester's view, and the token route never serves an
  // internal file. If one is passed here anyway, drop it rather than print the
  // name of a staff-only file on the requester's thread.
  const shown = access.kind === "token" ? items.filter((a) => !a.isInternal) : items;
  if (shown.length === 0) return null;
  const label = `${shown.length} ${shown.length === 1 ? "attachment" : "attachments"}`;
  return (
    <ul aria-label={label} className={compact ? "mt-3 space-y-2" : "mt-3 flex flex-wrap gap-2"}>
      {shown.map((a) => (
        <li key={a.id} className={compact ? undefined : "min-w-0 max-w-full"}>
          <Chip attachment={a} href={attachmentHref(access, a.id)} compact={compact} />
        </li>
      ))}
    </ul>
  );
}

function Chip({
  attachment: a,
  href,
  compact,
}: {
  attachment: SupportAttachment;
  href: string;
  compact: boolean;
}) {
  const inline = opensInline(a);
  const kind = attachmentKind(a);
  const Icon = kind === "image" ? ImageIcon : kind === "video" ? Film : FileText;
  const thumb = compact ? "h-10 w-10 rounded-lg" : "h-8 w-8 rounded";
  const tone = a.isInternal
    ? "border-amber-500/30 bg-amber-500/[0.06]"
    : "border-line bg-paper";

  return (
    <a
      href={href}
      // A new tab for an image, so the thread stays where it was. Downloads
      // stay in this tab — the response is an attachment, so it never
      // navigates away. noreferrer either way: on the token page, the
      // referring URL is the credential.
      target={inline ? "_blank" : undefined}
      rel="noopener noreferrer"
      className={
        compact
          ? `press flex min-h-[3.25rem] items-center gap-3 rounded-xl border px-3 py-2 active:bg-wash ${tone}`
          : `press group inline-flex max-w-full items-center gap-2.5 rounded-md border py-1.5 pl-1.5 pr-3 hover:border-ink/30 hover:bg-wash focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-phosphor focus-visible:ring-offset-2 focus-visible:ring-offset-paper ${tone}`
      }
    >
      {inline ? (
        // eslint-disable-next-line @next/next/no-img-element -- a re-authorized, short-lived URL; next/image would cache it
        <img
          src={href}
          alt=""
          loading="lazy"
          decoding="async"
          className={`${thumb} shrink-0 bg-wash object-cover`}
        />
      ) : (
        <span aria-hidden className={`${thumb} flex shrink-0 items-center justify-center bg-wash`}>
          <Icon className="h-4 w-4 text-ink-faint" />
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span
          className={`block truncate text-ink ${
            compact ? "text-[14px]" : "max-w-[16rem] text-[13px] group-hover:underline"
          }`}
        >
          {a.fileName}
        </span>
        <span className="mt-0.5 flex items-center gap-1.5 font-mono text-[11px] leading-tight text-ink-faint">
          {formatBytes(a.sizeBytes)}
          {a.isInternal && (
            <span className="inline-flex items-center gap-1 uppercase tracking-wider text-amber-700 dark:text-amber-300">
              <NotebookPen className="h-3 w-3" aria-hidden />
              internal
            </span>
          )}
        </span>
      </span>
      {compact && !inline && <Download className="h-4 w-4 shrink-0 text-ink-faint" aria-hidden />}
      <span className="sr-only">{inline ? " (opens in a new tab)" : " (downloads)"}</span>
    </a>
  );
}
