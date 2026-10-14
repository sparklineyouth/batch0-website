"use client";
import { useState } from "react";
import { ExternalLink, Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { pitchPreview, safeHttpsUrl } from "@/lib/google-drive-links";

/**
 * A pitch deck or video link: inline preview when it is Google Docs/Slides/
 * Drive, YouTube or Loom (exact-host allow-list), always an "Open" link.
 * Anything that isn't https renders nothing — the stored value is
 * member-writable, so it is re-checked here, not trusted.
 *
 * `collapsed` keeps the preview behind a Preview toggle (the team's own form
 * and the admin page); mentors and investors, who are there to watch, get it
 * open.
 */
export function PitchLinkPreview({
  url,
  title,
  collapsed = false,
  className = "",
}: {
  url: string | null | undefined;
  title: string;
  collapsed?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(!collapsed);
  const href = safeHttpsUrl(url);
  if (!href) return null;
  const preview = pitchPreview(href);
  return (
    <div className={className}>
      {preview && open && (
        <iframe
          src={preview.src}
          title={title}
          loading="lazy"
          referrerPolicy={preview.provider === "google" ? "no-referrer" : "strict-origin-when-cross-origin"}
          sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-presentation"
          allow="fullscreen; picture-in-picture; encrypted-media"
          allowFullScreen
          className="mb-2 aspect-video w-full rounded-md border border-line bg-paper"
        />
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 text-sm text-phosphor-ink hover:underline"
        >
          <ExternalLink className="h-3.5 w-3.5" /> Open {title.toLowerCase()}
        </a>
        {preview && collapsed && (
          <Button variant="ghost" size="sm" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            {open ? "Hide preview" : "Preview"}
          </Button>
        )}
      </div>
    </div>
  );
}
