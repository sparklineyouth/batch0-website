"use client";
import { useState } from "react";
import { Card } from "@/components/ui/card";
import { Copy, Check, Sparkles } from "lucide-react";

export function ReferralCard({
  code,
  siteUrl,
  referralCount,
}: {
  code: string;
  siteUrl: string;
  referralCount: number;
}) {
  const link = `${siteUrl}/apply?ref=${code}`;
  const [copied, setCopied] = useState(false);

  function copy() {
    navigator.clipboard
      .writeText(link)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  }

  return (
    <Card>
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="inline-flex items-center gap-2 rounded-full bg-spark/10 px-2.5 py-0.5 text-xs font-semibold text-spark-ink">
            <Sparkles className="h-3.5 w-3.5" />
            Refer a friend
          </div>
          <p className="mt-3 text-sm text-ink-soft">
            Send this link to other high schoolers. We'll fast-track their
            application and you'll get a credit toward a 1:1 mentor session.
          </p>
        </div>
        <div className="text-right">
          <div className="text-xs uppercase tracking-wider text-ink-faint">
            Your referrals
          </div>
          <div className="mt-1 text-2xl font-bold text-spark-ink">
            {referralCount}
          </div>
        </div>
      </div>
      <div className="mt-4 flex items-center gap-2 rounded-lg border border-line bg-paper px-3 py-2">
        <code className="flex-1 truncate text-xs text-ink-soft">{link}</code>
        <button
          type="button"
          onClick={copy}
          className="inline-flex items-center gap-1 rounded-md border border-line px-2 py-1 text-xs text-ink-soft hover:bg-wash hover:text-ink"
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
      </div>
    </Card>
  );
}
