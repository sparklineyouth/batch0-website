"use client";

import { useState } from "react";
import { Copy, Check } from "lucide-react";

/** Copy a template's markdown to the clipboard so a holder can paste it into
 *  their own doc and start filling it in. */
export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard
          .writeText(text)
          .then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
          .catch(() => {});
      }}
      className="inline-flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1 text-xs text-ink-soft hover:border-ink/30 hover:text-ink"
    >
      {copied ? (
        <>
          <Check className="h-3 w-3" /> Copied
        </>
      ) : (
        <>
          <Copy className="h-3 w-3" /> Copy
        </>
      )}
    </button>
  );
}
