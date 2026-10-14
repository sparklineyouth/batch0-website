import { Download } from "lucide-react";
import { LocalTime } from "@/components/ui/local-time";
import type { OlderUpload, OlderUploadsState } from "@/lib/team-drive";

/**
 * Files from the retired in-app uploads, download only. Renders nothing when
 * there are none, which is the case for anyone who joined after Google Drive
 * replaced them. `unavailable` (a download just bounced back) opens the list
 * with a one-line notice.
 */
export function OlderUploads({
  team,
  mine,
  unavailable = false,
  className = "",
}: OlderUploadsState & { className?: string }) {
  const total = team.length + mine.length;
  const notice = unavailable ? (
    <p
      role="alert"
      className="mt-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300"
    >
      That file isn&apos;t available any more.
    </p>
  ) : null;
  // id: the download route's failure redirect lands here (#older-uploads).
  if (total === 0) return notice ? <div id="older-uploads" className={className}>{notice}</div> : null;
  return (
    <details
      id="older-uploads"
      open={unavailable || undefined}
      className={`rounded-2xl border border-line bg-wash px-5 py-4 ${className}`}
    >
      <summary className="cursor-pointer text-sm font-semibold">Older uploads ({total})</summary>
      {notice}
      <p className="mt-1 text-xs text-ink-faint">
        Read-only. Download what you need and move it to Google Drive.
      </p>
      {team.length > 0 && <Group label="Team" files={team} />}
      {mine.length > 0 && <Group label="Only you" files={mine} />}
    </details>
  );
}

function Group({ label, files }: { label: string; files: OlderUpload[] }) {
  return (
    <div className="mt-4">
      <div className="text-xs font-medium text-ink-soft">{label}</div>
      <ul className="mt-1 divide-y divide-line">
        {files.map((f) => (
          <li key={f.href} className="flex items-center justify-between gap-3 py-2">
            <div className="min-w-0">
              <div className="truncate text-sm text-ink">{f.name}</div>
              {f.createdAt && (
                <div className="text-xs text-ink-faint">
                  <LocalTime value={f.createdAt} mode="date" />
                </div>
              )}
            </div>
            {/* A plain anchor, not <Link>: the route answers with a redirect to
                a short-lived signed URL and must not be prefetched. */}
            <a
              href={f.href}
              rel="nofollow"
              className="inline-flex shrink-0 items-center gap-1.5 text-xs font-medium text-phosphor-ink hover:underline"
            >
              <Download className="h-3.5 w-3.5" /> Download
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
