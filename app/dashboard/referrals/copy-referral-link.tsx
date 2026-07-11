"use client";
import { useState } from "react";
import { Copy, Check } from "lucide-react";

export function CopyReferralLink({
  href,
  code,
}: {
  href: string;
  code: string;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(href);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard may be blocked (insecure context, no permission).
      // Silently no-op so the UI doesn't show a misleading toast — the
      // value is still visible as text the user can select.
    }
  }

  return (
    <div className="mt-2 flex flex-col gap-2 md:flex-row md:items-center">
      <div className="min-w-0 flex-1 select-all overflow-x-auto rounded-md border border-line bg-paper px-3 py-2 font-mono text-sm text-ink-soft">
        {href}
      </div>
      <button
        type="button"
        onClick={copy}
        className="inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md border border-line px-3 py-2 text-sm font-medium text-ink hover:border-ink/30 hover:bg-wash"
      >
        {copied ? (
          <>
            <Check className="h-3.5 w-3.5 text-emerald-700 dark:text-emerald-300" />
            Copied
          </>
        ) : (
          <>
            <Copy className="h-3.5 w-3.5" />
            Copy link
          </>
        )}
      </button>
      <span className="font-mono text-[11px] text-ink-faint md:ml-2">
        code: {code}
      </span>
    </div>
  );
}
