"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  Input,
  Label,
  Textarea,
  Select,
  FieldError,
} from "@/components/ui/input";
import { requestPitchCoach } from "./actions";
import { getActionError } from "@/lib/action-error";

type Kind = "deck_url" | "video_url" | "transcript";

export function PitchCoachForm({ teamId }: { teamId: string }) {
  const router = useRouter();
  const [kind, setKind] = useState<Kind>("transcript");
  const [source, setSource] = useState("");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | undefined>();

  function submit() {
    setError(undefined);
    start(async () => {
      try {
        await requestPitchCoach({ teamId, sourceKind: kind, source });
        setSource("");
        router.refresh();
      } catch (e) {
        setError(getActionError(e));
      }
    });
  }

  return (
    <div className="space-y-4">
      <div>
        <Label>What are we scoring?</Label>
        <Select value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
          <option value="transcript">Pitch transcript / written script</option>
          <option value="deck_url">Deck URL (Slides / PDF)</option>
          <option value="video_url">Video URL (Loom / YouTube)</option>
        </Select>
      </div>
      {kind === "transcript" ? (
        <div>
          <Label>Pitch script or transcript</Label>
          <Textarea
            rows={10}
            value={source}
            onChange={(e) => setSource(e.target.value)}
            placeholder="Paste your 2-minute pitch script, or a transcript of your last recorded pitch."
            maxLength={12000}
          />
          <p className="mt-1 text-[11px] text-ink-faint">
            {source.length.toLocaleString()} / 12,000 chars
          </p>
        </div>
      ) : (
        <>
          <div>
            <Label>URL</Label>
            <Input
              type="url"
              value={source}
              onChange={(e) => setSource(e.target.value)}
              placeholder="https://…"
            />
          </div>
          <p className="text-xs text-amber-700 dark:text-amber-300">
            The coach can't follow URLs to read decks or watch videos yet, so
            it scores based on the URL + filename + any context it can infer.
            For deepest feedback, paste a transcript instead.
          </p>
        </>
      )}
      {error && <FieldError>{error}</FieldError>}
      <div className="flex justify-end">
        <Button onClick={submit} disabled={pending || !source.trim()}>
          {pending ? "Coaching…" : "Get feedback"}
        </Button>
      </div>
    </div>
  );
}
