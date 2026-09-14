"use client";

import { useState } from "react";
import { track } from "@vercel/analytics";
import { Check, Copy, Download, Share2 } from "lucide-react";

const KIT_URL = "https://batch0.org/start?utm_source=student_share&utm_medium=referral&utm_campaign=founder_starter_kit";
const WORKSHEET_URL = "/resources/founder-starter-worksheet.txt";

export function StarterKitShare() {
  const [message, setMessage] = useState("");
  const [copied, setCopied] = useState(false);

  async function copyWorksheet() {
    try {
      const response = await fetch(WORKSHEET_URL);
      if (!response.ok) throw new Error("Worksheet unavailable");
      await navigator.clipboard.writeText(await response.text());
      setCopied(true);
      setMessage("Worksheet copied. Paste it into your notes and make it yours.");
      track("starter_kit_action", { action: "copy_worksheet" });
    } catch {
      setMessage("Copy is unavailable in this browser. Download the worksheet below instead.");
    }
  }

  async function shareKit() {
    const data = {
      title: "Free founder starter kit · batch0",
      text: "Five practical exercises to turn a startup idea into a test. Free worksheet, no signup.",
      url: KIT_URL,
    };
    try {
      if (navigator.share) {
        await navigator.share(data);
        setMessage("Thanks for sharing the starter kit.");
        track("starter_kit_action", { action: "share" });
      } else {
        await navigator.clipboard.writeText(KIT_URL);
        setMessage("Starter kit link copied. Send it to someone who is building.");
        track("starter_kit_action", { action: "copy_link" });
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setMessage("Sharing is unavailable. You can copy this link: https://batch0.org/start");
    }
  }

  const buttonClass = "inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-line bg-paper px-4 py-3 text-sm font-semibold text-ink hover:bg-wash focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-phosphor";

  return (
    <div>
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
        <button type="button" onClick={copyWorksheet} className={buttonClass}>
          {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
          {copied ? "Worksheet copied" : "Copy the worksheet"}
        </button>
        <a
          href={WORKSHEET_URL}
          download="batch0-founder-starter-worksheet.txt"
          onClick={() => track("starter_kit_action", { action: "download_worksheet" })}
          className={buttonClass}
        >
          <Download className="h-4 w-4" /> Download .txt
        </a>
        <button type="button" onClick={shareKit} className={buttonClass}>
          <Share2 className="h-4 w-4" /> Share the kit
        </button>
      </div>
      <p className="mt-3 min-h-5 text-sm text-ink-soft" role="status" aria-live="polite">
        {message}
      </p>
    </div>
  );
}
