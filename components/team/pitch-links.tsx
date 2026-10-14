import { ExternalLink } from "lucide-react";
import { pitchPreview, safeHttpsUrl } from "@/lib/google-drive-links";

/**
 * A pitch deck or video link: inline preview when it is Google Docs/Slides/
 * Drive, YouTube or Loom (exact-host allow-list), always an "Open" link.
 * Anything that isn't https renders nothing — the stored value is
 * member-writable, so it is re-checked here, not trusted.
 */
export function PitchLinkPreview({
  url,
  title,
  className = "",
}: {
  url: string | null | undefined;
  title: string;
  className?: string;
}) {
  const href = safeHttpsUrl(url);
  if (!href) return null;
  const preview = pitchPreview(href);
  return (
    <div className={className}>
      {preview && (
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
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1.5 text-sm text-phosphor-ink hover:underline"
      >
        <ExternalLink className="h-3.5 w-3.5" /> Open {title.toLowerCase()}
      </a>
    </div>
  );
}
