"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Textarea, Label, FieldError } from "@/components/ui/input";
import { LocalTime } from "@/components/ui/local-time";
import { CheckCircle2 } from "lucide-react";
import { PitchLinkPreview } from "@/components/team/pitch-links";
import { upsertPitchSubmission, submitPitch } from "./pitch-actions";

type Pitch = {
  team_id: string;
  /** Absent until migration 0094 adds the column. */
  deck_url?: string | null;
  deck_path: string | null;
  video_path: string | null;
  video_url: string | null;
  notes: string | null;
  submitted_at: string | null;
};

export function TeamPitchTab({
  teamId,
  pitch,
}: {
  teamId: string;
  pitch: Pitch | null;
}) {
  const router = useRouter();
  const [deckUrl, setDeckUrl] = useState(pitch?.deck_url ?? "");
  const [videoUrl, setVideoUrl] = useState(pitch?.video_url ?? "");
  const [notes, setNotes] = useState(pitch?.notes ?? "");
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | undefined>();

  function save() {
    setErr(undefined);
    start(async () => {
      const res = await upsertPitchSubmission({
        teamId,
        deck_url: deckUrl,
        video_url: videoUrl,
        notes,
      });
      if (!res.ok) setErr(res.error);
      else router.refresh();
    });
  }

  function submit() {
    setErr(undefined);
    start(async () => {
      const res = await submitPitch({ teamId });
      if (!res.ok) setErr(res.error);
      else router.refresh();
    });
  }

  const submitted = !!pitch?.submitted_at;
  const ready = !!(pitch?.deck_url || pitch?.video_url);
  // Decks/videos uploaded before links replaced uploads were never visible to
  // judges. Point the team at them so they can re-share as a link.
  const orphanedUpload =
    (!!pitch?.deck_path && !pitch?.deck_url) ||
    (!!pitch?.video_path && !pitch?.video_url);

  return (
    <div className="space-y-6">
      <Card>
        <h3 className="text-base font-semibold">Demo Day submission</h3>
        <p className="mt-1 text-xs text-ink-faint">
          Add your deck and pitch video links, then submit.
        </p>

        {submitted && (
          <div className="mt-4 flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-300">
            <CheckCircle2 className="h-4 w-4" />
            Submitted on <LocalTime value={pitch!.submitted_at} />. Investors and
            judges can now see it.
          </div>
        )}
        {orphanedUpload && (
          <p className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
            Judges can't see uploaded files. Download yours from Drive → Older
            uploads, put it in Google Drive and paste the link here.
          </p>
        )}

        <div className="mt-5 space-y-5">
          <div>
            <Label htmlFor="pitch-deck-url">Pitch deck link</Label>
            <Input
              id="pitch-deck-url"
              type="url"
              inputMode="url"
              value={deckUrl}
              onChange={(e) => setDeckUrl(e.target.value)}
              placeholder="https://docs.google.com/presentation/d/…"
            />
            <p className="mt-1 text-xs text-ink-faint">
              Share it as “Anyone with the link”.
            </p>
            <PitchLinkPreview url={pitch?.deck_url ?? null} title="Pitch deck" className="mt-3" />
          </div>
          <div>
            <Label htmlFor="pitch-video-url">Pitch video link</Label>
            <Input
              id="pitch-video-url"
              type="url"
              inputMode="url"
              value={videoUrl}
              onChange={(e) => setVideoUrl(e.target.value)}
              placeholder="YouTube, Loom or Google Drive"
            />
            <PitchLinkPreview url={pitch?.video_url ?? null} title="Pitch video" className="mt-3" />
          </div>
          <div>
            <Label htmlFor="pitch-notes">Notes for judges (optional)</Label>
            <Textarea
              id="pitch-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={4}
              maxLength={2000}
              placeholder="Context, asks, traction highlights…"
            />
          </div>
          <div className="flex items-center justify-between border-t border-line pt-4">
            <Button variant="secondary" onClick={save} disabled={pending}>
              {pending ? "Saving…" : "Save draft"}
            </Button>
            <Button onClick={submit} disabled={pending || !ready || submitted}>
              {submitted
                ? "Already submitted"
                : pending
                  ? "Submitting…"
                  : "Submit for Demo Day"}
            </Button>
          </div>
          <FieldError>{err}</FieldError>
        </div>
      </Card>
    </div>
  );
}
