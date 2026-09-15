"use client";
import { useState } from "react";
import { Copy, Check } from "lucide-react";

/** Copies a ticket's pay link. Compact enough to sit in a table row. */
export function CopyLinkButton({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard may be blocked (insecure context, no permission). No-op
      // rather than a misleading "Copied" — the link is still in the row.
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      title={url}
      className="inline-flex items-center gap-1 rounded-md border border-line bg-wash px-2 py-1 text-xs text-ink-soft hover:border-ink/30 hover:text-ink"
    >
      {copied ? (
        <>
          <Check className="h-3 w-3 text-emerald-700 dark:text-emerald-300" />
          Copied
        </>
      ) : (
        <>
          <Copy className="h-3 w-3" />
          Copy link
        </>
      )}
    </button>
  );
}
