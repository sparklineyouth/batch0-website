"use client";

import { useState, useTransition } from "react";
import { Input, Textarea, Label } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { getActionError } from "@/lib/action-error";
import type { Rebuild } from "@/lib/founder-pass-perks";
import { submitRebuildAction } from "@/app/pass/actions";

/**
 * The seven-day rebuild (perk 4), shown under a declined pass holder's decision.
 * Only rendered by the application page when the holder is actually eligible
 * (holds a live pass + latest application rejected), so this component doesn't
 * re-check eligibility — it just collects the submission or shows its status.
 */
export function RebuildForm({ existing }: { existing: Rebuild | null }) {
  if (existing) {
    return (
      <div className="mt-4 rounded-lg border border-phosphor/30 bg-phosphor/[0.04] p-4">
        <div className="text-[11px] font-medium uppercase tracking-wider text-phosphor-ink">
          Rebuild submitted
        </div>
        <p className="mt-1 text-sm text-ink-soft">
          {existing.status === "reviewed"
            ? "Your rebuild has been reviewed — check your latest decision above."
            : "Your updated application is queued for one fresh human review. We'll email you when there's a decision."}
        </p>
      </div>
    );
  }
  return <RebuildSubmit />;
}

function RebuildSubmit() {
  const [open, setOpen] = useState(false);
  const [summary, setSummary] = useState("");
  const [linkUrl, setLinkUrl] = useState("");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | undefined>();

  function submit() {
    setError(undefined);
    start(async () => {
      try {
        const res = await submitRebuildAction({ summary, linkUrl });
        if (!res.ok) setError(res.message);
        // Success revalidates the page; the parent re-renders with the
        // submitted state, replacing this form.
      } catch (e) {
        setError(getActionError(e));
      }
    });
  }

  if (!open) {
    return (
      <div className="mt-4 rounded-lg border border-line bg-wash p-4">
        <p className="text-sm font-medium text-ink">
          Build your way back in
        </p>
        <p className="mt-1 text-sm text-ink-soft">
          Your pass gives you one shot to earn a fresh review. Validate the
          problem, talk to potential users, ship something small, and tell us
          what you learned. One human reads your updated application again.
        </p>
        <Button
          size="sm"
          variant="secondary"
          className="mt-3"
          onClick={() => setOpen(true)}
        >
          Start the seven-day build
        </Button>
      </div>
    );
  }

  return (
    <div className="mt-4 space-y-3 rounded-lg border border-line bg-wash p-4">
      <div>
        <Label htmlFor="rebuild-summary">What did you build and learn?</Label>
        <Textarea
          id="rebuild-summary"
          rows={5}
          value={summary}
          maxLength={6000}
          placeholder="Who did you talk to? What did you ship? What surprised you?"
          disabled={pending}
          onChange={(e) => setSummary(e.target.value)}
        />
      </div>
      <div>
        <Label htmlFor="rebuild-link">Link (optional)</Label>
        <Input
          id="rebuild-link"
          value={linkUrl}
          placeholder="Demo, repo, or a short writeup"
          disabled={pending}
          onChange={(e) => setLinkUrl(e.target.value)}
        />
      </div>
      {error && <p className="text-xs text-red-700 dark:text-red-300">{error}</p>}
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={submit} disabled={pending}>
          {pending ? "Submitting…" : "Submit for a fresh review"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setOpen(false)}
          disabled={pending}
        >
          Cancel
        </Button>
      </div>
      <p className="text-xs text-ink-faint">
        Completing the build doesn't guarantee acceptance — it guarantees a
        fresh look.
      </p>
    </div>
  );
}
