import { ExternalLink } from "lucide-react";

/** Submitted work, read-only. No hooks, so server and client pages both use it. */
export function SubmissionView({ body, link }: { body: string | null; link: string | null }) {
  return (
    <div className="space-y-2 text-sm">
      {link && (
        <a
          href={link}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex max-w-full items-center gap-1.5 break-all text-phosphor-ink underline"
        >
          <ExternalLink className="h-3.5 w-3.5 shrink-0" />
          {link}
        </a>
      )}
      {body && (
        <p className="whitespace-pre-wrap break-words text-ink-soft [overflow-wrap:anywhere]">{body}</p>
      )}
    </div>
  );
}
