"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input, Textarea, Label, Select } from "@/components/ui/input";
import { Toggle } from "@/components/ui/toggle";
import { getActionError } from "@/lib/action-error";
import { awardLabelFor, type ChallengePrize } from "@/lib/challenges-shared";
import { LocalTime } from "@/components/ui/local-time";
import { reviewChallengeSubmission } from "../../../actions";

type ReviewStatus = "submitted" | "shortlisted" | "funded" | "rejected";
const STATUSES: { value: ReviewStatus; label: string }[] = [
  { value: "submitted", label: "New" },
  { value: "shortlisted", label: "Shortlist" },
  { value: "funded", label: "Winner" },
  { value: "rejected", label: "Not selected" },
];

export function SubmissionReview({
  prizes,
  winnersPublished,
  editWindowOpenUntil,
  initial,
}: {
  prizes: ChallengePrize[];
  winnersPublished: boolean;
  /** Set while entrants may still edit: decisions (which lock an entry) wait. */
  editWindowOpenUntil: string | null;
  initial: {
    submissionId: string;
    status: ReviewStatus;
    prizeId: string | null;
    awardLabel: string | null;
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
  const [prizeId, setPrizeId] = useState(initial.prizeId ?? "");
  const [payout, setPayout] = useState(initial.payoutCents != null ? String(initial.payoutCents / 100) : "");
  const [notes, setNotes] = useState(initial.reviewNotes ?? "");
  const [winnerPublic, setWinnerPublic] = useState(initial.winnerPublic);
  const [publicName, setPublicName] = useState(initial.publicName ?? "");
  const [publicBlurb, setPublicBlurb] = useState(initial.publicBlurb ?? "");
  const [publicUrl, setPublicUrl] = useState(initial.publicProjectUrl ?? "");

  const [pending, start] = useTransition();
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const touch = () => setSaved(false);
  // The prize this winner was awarded may since have been removed from the
  // list; keep it selectable so a save doesn't silently change what they won.
  const orphan = !!initial.prizeId && !prizes.some((p) => p.id === initial.prizeId);
  const decisionsLocked = !!editWindowOpenUntil && initial.status === "submitted";

  function pickPrize(id: string) {
    setPrizeId(id);
    touch();
    const p = prizes.find((x) => x.id === id);
    // A cash prize pre-fills the payout; you can still override it.
    if (p?.kind === "cash" && p.valueCents != null && !payout) setPayout(String(p.valueCents / 100));
  }

  function onSave() {
    setError(undefined);
    setSaved(false);
    start(async () => {
      try {
        const cents = payout.trim() ? Math.round(Number(payout) * 100) : null;
        const res = await reviewChallengeSubmission({
          submissionId: initial.submissionId,
          status,
          prize_id: status === "funded" ? prizeId || null : null,
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
    <div className="space-y-5">
      <div>
        <Label>Decision</Label>
        {decisionsLocked && (
          <p className="mb-2 rounded-md border border-line bg-wash px-2.5 py-2 text-[12px] text-ink-soft">
            Entrants can keep editing until <LocalTime value={editWindowOpenUntil} mode="datetime-short" />. A
            decision would lock this entry, so decisions unlock when submissions close. Notes save anytime.
          </p>
        )}
        <div className="grid grid-cols-2 gap-1.5">
          {STATUSES.map((s) => (
            <button
              key={s.value}
              type="button"
              disabled={decisionsLocked && s.value !== "submitted"}
              onClick={() => {
                setStatus(s.value);
                if (s.value !== "funded") setWinnerPublic(false);
                touch();
              }}
              className={`rounded-md border px-3 py-2 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-40 ${
                status === s.value
                  ? s.value === "funded"
                    ? "border-phosphor bg-phosphor text-on-phosphor"
                    : "border-ink/40 bg-wash text-ink"
                  : "border-line text-ink-soft hover:border-ink/30 hover:text-ink"
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {status === "funded" && (
        <>
          {(prizes.length > 0 || orphan) && (
            <div>
              <Label htmlFor="prize">Prize won</Label>
              <Select id="prize" value={prizeId} onChange={(e) => pickPrize(e.target.value)}>
                <option value="">— none / custom —</option>
                {orphan && (
                  <option value={initial.prizeId!}>
                    {(initial.awardLabel ?? "Removed prize") + " (no longer listed)"}
                  </option>
                )}
                {prizes.map((p) => (
                  <option key={p.id} value={p.id}>
                    {awardLabelFor(p)}
                  </option>
                ))}
              </Select>
            </div>
          )}
          <div>
            <Label htmlFor="payout">Cash payout (USD)</Label>
            <Input
              id="payout"
              type="number"
              min={0}
              step="0.01"
              value={payout}
              onChange={(e) => {
                setPayout(e.target.value);
                touch();
              }}
              placeholder="0"
            />
            <p className="mt-1 text-xs text-ink-faint">For your books. Paid offline. Leave blank for item prizes.</p>
          </div>
        </>
      )}

      <div>
        <Label htmlFor="notes">Private notes</Label>
        <Textarea
          id="notes"
          rows={3}
          value={notes}
          onChange={(e) => {
            setNotes(e.target.value);
            touch();
          }}
          placeholder="Admin-only."
        />
      </div>

      {status === "funded" && (
        <div className="space-y-3">
          <Toggle
            label="Show publicly"
            description="Adds them to the winners list. You choose exactly what's shown — never their answers or email."
            checked={winnerPublic}
            onChange={(v) => {
              setWinnerPublic(v);
              touch();
            }}
          />
          {winnerPublic && (
            <div className="space-y-3">
              <div>
                <Label htmlFor="public-name">Display name</Label>
                <Input id="public-name" value={publicName} onChange={(e) => { setPublicName(e.target.value); touch(); }} placeholder="e.g. Maya R." />
              </div>
              <div>
                <Label htmlFor="public-blurb">What they built</Label>
                <Input id="public-blurb" value={publicBlurb} onChange={(e) => { setPublicBlurb(e.target.value); touch(); }} placeholder="One line" />
              </div>
              <div>
                <Label htmlFor="public-url">Project link</Label>
                <Input id="public-url" type="url" value={publicUrl} onChange={(e) => { setPublicUrl(e.target.value); touch(); }} placeholder="https://…" />
              </div>
              {!winnersPublished && (
                <p className="text-xs text-amber-700 dark:text-amber-300">
                  Turn on &quot;Publish winners&quot; in the editor for this to appear on the site.
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {error && (
        <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-300">{error}</p>
      )}

      <div className="flex items-center gap-3">
        <Button type="button" onClick={onSave} disabled={pending}>
          {pending ? "Saving…" : "Save review"}
        </Button>
        {saved && <span className="text-xs text-emerald-700 dark:text-emerald-300">Saved.</span>}
      </div>
    </div>
  );
}
