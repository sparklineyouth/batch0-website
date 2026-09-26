"use client";
import { useEffect, useRef, useState } from "react";
import { Check, Copy, Share2 } from "lucide-react";

/**
 * A read-only link with Copy and (where the browser has it) native Share —
 * the referral link on the event and submit pages.
 */
export function ShareLink({
  url,
  shareText,
  compact = false,
}: {
  url: string;
  shareText?: string;
  compact?: boolean;
}) {
  const [copied, setCopied] = useState<"no" | "yes" | "selected">("no");
  const inputRef = useRef<HTMLInputElement>(null);
  // Read after mount: the server has no navigator, and deciding during render
  // would hydrate a different button row than the server sent.
  const [canShare, setCanShare] = useState(false);
  useEffect(() => {
    setCanShare(typeof navigator.share === "function");
  }, []);

  async function copy() {
    let ok = false;
    try {
      await navigator.clipboard.writeText(url);
      ok = true;
    } catch {
      // Clipboard API refused (in-app webviews, http, permissions): fall back
      // to selecting the text and the legacy copy command.
      const el = inputRef.current;
      if (el) {
        el.focus();
        el.select();
        try {
          ok = document.execCommand("copy");
        } catch {
          ok = false;
        }
      }
    }
    // Only claim "Copied" when something was actually copied.
    setCopied(ok ? "yes" : "selected");
    setTimeout(() => setCopied("no"), 2200);
  }

  async function share() {
    try {
      await navigator.share({ url, text: shareText });
    } catch {
      /* dismissed */
    }
  }

  return (
    <div className="flex items-stretch gap-2">
      <input
        ref={inputRef}
        readOnly
        value={url}
        onFocus={(e) => e.currentTarget.select()}
        className={`min-w-0 flex-1 rounded-md border border-line bg-paper px-3 font-mono text-ink ${
          compact ? "h-9 text-[12px]" : "h-10 text-[13px]"
        }`}
        aria-label="Your referral link"
      />
      <button
        type="button"
        onClick={copy}
        className={`press inline-flex shrink-0 items-center gap-1.5 rounded-md bg-phosphor px-3 font-semibold text-on-phosphor hover:bg-phosphor-200 ${
          compact ? "h-9 text-[12px]" : "h-10 text-[13px]"
        }`}
      >
        {copied === "yes" ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
        {copied === "yes" ? "Copied" : copied === "selected" ? "Selected — copy it" : "Copy"}
      </button>
      {canShare && (
        <button
          type="button"
          onClick={share}
          aria-label="Share"
          className={`press inline-flex shrink-0 items-center justify-center rounded-md border border-line bg-paper px-3 text-ink hover:bg-wash ${
            compact ? "h-9" : "h-10"
          }`}
        >
          <Share2 className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}
