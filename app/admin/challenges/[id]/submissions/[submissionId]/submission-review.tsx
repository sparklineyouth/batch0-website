"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input, Textarea, Label } from "@/components/ui/input";
import { Toggle } from "@/components/ui/toggle";
import { getActionError } from "@/lib/action-error";
import { reviewChallengeSubmission } from "../../../actions";

type ReviewStatus = "submitted" | "shortlisted" | "funded" | "rejected";
const STATUSES: ReviewStatus[] = [
  "submitted",
  "shortlisted",
  "funded",
  "rejected",
];

export function SubmissionReview({
  initial,
}: {
  initial: {
    submissionId: string;
    status: ReviewStatus;
    payoutCents: number | null;
    reviewNotes: string | null;
    winnerPublic: boolean;
    publicName: string | null;
    publicBlurb: string | null;
    publicProjectUrl: string | null;
  };
}) {
  const router = useRouter();
  const [status, setStatus] = useState<ReviewStatus>(initial.status);
  const [payout, setPayout] = useState(
    initial.payoutCents != null ? String(initial.payoutCents / 100) : "",
  );
  const [notes, setNotes] = useState(initial.reviewNotes ?? "");
  const [winnerPublic, setWinnerPublic] = useState(initial.winnerPublic);
  const [publicName, setPublicName] = useState(initial.publicName ?? "");
  const [publicBlurb, setPublicBlurb] = useState(initial.publicBlurb ?? "");
  const [publicUrl, setPublicUrl] = useState(initial.publicProjectUrl ?? "");

  const [pending, start] = useTransition();
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | undefined>();

  function onSave() {
    setError(undefined);
    setSaved(false);
    start(async () => {
      try {
        const cents = payout.trim() ? Math.round(Number(payout) * 100) : null;
        const res = await reviewChallengeSubmission({
          submissionId: initial.submissionId,
          status,
          payout_amount_cents: cents,
          review_notes: notes,
          winner_public: winnerPublic,
          public_name: publicName,
          public_blurb: publicBlurb,
          public_project_url: publicUrl,
        });
        if (!res.ok) {
          setError(res.error);
          return;
        }
        setSaved(true);
        router.refresh();
      } catch (err) {
        setError(getActionError(err));
      }
    });
  }

  return (
    <div className="space-y-6">
      <div>
        <Label>Decision</Label>
        <div className="flex flex-wrap gap-2">
          {STATUSES.map((s) => {
            const active = status === s;
            return (
              <button
                key={s}
                type="button"
                onClick={() => {
                  setStatus(s);
                  setSaved(false);
                }}
                className={`rounded-md border px-3 py-1.5 text-xs uppercase tracking-wider transition ${
                  active
                    ? "border-phosphor bg-phosphor/10 text-phosphor-ink"
                    : "border-line text-ink-soft hover:border-ink/30 hover:text-ink"
                }`}
              >
                {s}
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <Label htmlFor="payout">Payout (USD)</Label>
        <Input
          id="payout"
          type="number"
          min={0}
          step="1"
          value={payout}
          onChange={(e) => {
            setPayout(e.target.value);
            setSaved(false);
          }}
          placeholder="500"
          className="max-w-40"
        />
        <p className="mt-1 text-xs text-ink-faint">
          Recorded for your books. Paid offline.
        </p>
      </div>

      <div>
        <Label htmlFor="notes">Private notes</Label>
        <Textarea
          id="notes"
          rows={3}
          value={notes}
          onChange={(e) => {
            setNotes(e.target.value);
            setSaved(false);
          }}
          placeholder="Admin-only. Never shown publicly."
        />
      </div>

      <div className="rounded-xl border border-line bg-wash p-4">
        <Toggle
          label="Show on public winners strip"
          description="Only funded submissions can be published. You curate exactly what's shown — the applicant's real name and answers are never exposed."
          checked={winnerPublic}
          onChange={(v) => {
            setWinnerPublic(v);
            setSaved(false);
          }}
        />
        {winnerPublic && (
          <div className="mt-4 space-y-4">
            <div>
              <Label htmlFor="public-name">Public display name</Label>
              <Input
                id="public-name"
                value={publicName}
                onChange={(e) => {
                  setPublicName(e.target.value);
                  setSaved(false);
                }}
                placeholder="e.g. Maya R."
              />
            </div>
            <div>
              <Label htmlFor="public-blurb">Project blurb</Label>
              <Input
                id="public-blurb"
                value={publicBlurb}
                onChange={(e) => {
                  setPublicBlurb(e.target.value);
                  setSaved(false);
                }}
                placeholder="One line — what they built"
              />
            </div>
            <div>
              <Label htmlFor="public-url">Project link (optional)</Label>
              <Input
                id="public-url"
                type="url"
                value={publicUrl}
                onChange={(e) => {
                  setPublicUrl(e.target.value);
                  setSaved(false);
                }}
                placeholder="https://…"
              />
            </div>
            <p className="text-xs text-ink-faint">
              Also requires the challenge&apos;s &quot;Publish winners&quot;
              toggle to be on for anything to appear on the site.
            </p>
          </div>
        )}
      </div>

      {error && (
        <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-300">
          {error}
        </p>
      )}

      <div className="flex items-center gap-3">
        <Button type="button" onClick={onSave} disabled={pending}>
          {pending ? "Saving…" : "Save review"}
        </Button>
        {saved && (
          <span className="text-xs text-emerald-700 dark:text-emerald-300">
            Saved.
          </span>
        )}
      </div>
    </div>
  );
}
