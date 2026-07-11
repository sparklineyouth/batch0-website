"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Textarea, FieldError } from "@/components/ui/input";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Handshake } from "lucide-react";
import { createIntroRequest } from "./actions";

const STATUS_LABEL: Record<string, string> = {
  requested: "Intro requested",
  intro_made: "Intro made",
  meeting_held: "Met",
  committed: "Committed",
  wired: "Wired",
  passed: "Passed",
};

export function IntroRequestButton({
  teamId,
  existing,
  viewerRole,
}: {
  teamId: string;
  existing: { status: string; message: string | null } | null;
  viewerRole: "investor" | "admin";
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState(existing?.message ?? "");
  const [err, setErr] = useState<string | undefined>();
  const [pending, start] = useTransition();

  function send() {
    setErr(undefined);
    start(async () => {
      try {
        const result = await createIntroRequest({ teamId, message });
        if (!result.ok) {
          setErr(result.error);
          return;
        }
        setOpen(false);
        router.refresh();
      } catch (e: any) {
        // Network / framework-level failure — message is stripped in
        // prod but at least we don't crash silently.
        setErr(e?.message || "Couldn't send the request. Try again.");
      }
    });
  }

  if (existing) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-spark/30 bg-spark/10 px-3 py-2 text-xs font-semibold text-spark-ink">
        <Handshake className="h-3.5 w-3.5" />
        {STATUS_LABEL[existing.status] ?? existing.status}
      </div>
    );
  }

  // Admins can browse the investor surface but can't file intros —
  // intros must come from an actual investor profile.
  if (viewerRole === "admin") {
    return (
      <div className="rounded-lg border border-line bg-wash px-3 py-2 text-[11px] text-ink-soft">
        Admin view — intros must come from an investor account.
      </div>
    );
  }

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        <Handshake className="h-3.5 w-3.5" /> Request intro
      </Button>
      <ConfirmDialog
        open={open}
        title="Request an intro"
        description={
          <div className="space-y-2">
            <p>
              We'll route this to the Sparkline Youth team. They'll loop you in with
              the founders when appropriate.
            </p>
            <Textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="What caught your eye? What's your thesis?"
              maxLength={1000}
              rows={4}
            />
            <FieldError>{err}</FieldError>
          </div>
        }
        confirmLabel={pending ? "Sending…" : "Send request"}
        pending={pending}
        onConfirm={send}
        onCancel={() => !pending && setOpen(false)}
      />
    </>
  );
}
