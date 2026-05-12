"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Textarea, Label, FieldError } from "@/components/ui/input";
import { createClient } from "@/lib/supabase/client";
import { Upload, CheckCircle2 } from "lucide-react";
import {
  getTeamDriveUploadToken,
} from "./actions";
import {
  upsertPitchSubmission,
  submitPitch,
} from "./pitch-actions";

type Pitch = {
  team_id: string;
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
  const [videoUrl, setVideoUrl] = useState(pitch?.video_url ?? "");
  const [notes, setNotes] = useState(pitch?.notes ?? "");
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | undefined>();
  const [uploadingKind, setUploadingKind] = useState<"deck" | "video" | null>(
    null,
  );

  async function uploadAsset(kind: "deck" | "video", file: File) {
    setErr(undefined);
    setUploadingKind(kind);
    try {
      const { path, token } = await getTeamDriveUploadToken({
        teamId,
        filename: `pitch-${kind}-${file.name}`,
      });
      const supabase = createClient();
      const up = await supabase.storage
        .from("team-drive")
        .uploadToSignedUrl(path, token, file);
      if (up.error) throw up.error;
      await upsertPitchSubmission({
        teamId,
        [kind === "deck" ? "deck_path" : "video_path"]: path,
      } as any);
      router.refresh();
    } catch (e: any) {
      setErr(e.message ?? String(e));
    } finally {
      setUploadingKind(null);
    }
  }

  function saveMeta() {
    setErr(undefined);
    start(async () => {
      try {
        await upsertPitchSubmission({
          teamId,
          video_url: videoUrl,
          notes,
        });
        router.refresh();
      } catch (e: any) {
        setErr(e.message);
      }
    });
  }

  function submit() {
    setErr(undefined);
    start(async () => {
      try {
        await submitPitch({ teamId });
        router.refresh();
      } catch (e: any) {
        setErr(e.message);
      }
    });
  }

  const submitted = !!pitch?.submitted_at;
  const ready =
    !!(pitch?.deck_path || pitch?.video_path || pitch?.video_url);

  return (
    <div className="space-y-6">
      <Card>
        <h3 className="text-base font-semibold">Demo Day submission</h3>
        <p className="mt-1 text-xs text-white/50">
          Upload your pitch deck (PDF) and a 3-min recorded pitch (or paste a
          link), add any notes for judges, then submit. You can keep editing
          before you submit.
        </p>

        {submitted && (
          <div className="mt-4 flex items-center gap-2 rounded-lg border border-emerald-400/30 bg-emerald-400/10 px-3 py-2 text-xs text-emerald-200">
            <CheckCircle2 className="h-4 w-4" />
            Submitted on{" "}
            {new Date(pitch!.submitted_at!).toLocaleString()}. Investors and
            judges can now see it.
          </div>
        )}

        <div className="mt-5 space-y-5">
          <UploadRow
            label="Pitch deck (PDF)"
            badge={pitch?.deck_path ? "Uploaded" : "Not uploaded"}
            accept="application/pdf,.pdf"
            uploading={uploadingKind === "deck"}
            onPick={(f) => uploadAsset("deck", f)}
          />
          <UploadRow
            label="Pitch video (MP4/MOV)"
            badge={pitch?.video_path ? "Uploaded" : "Not uploaded"}
            accept="video/*"
            uploading={uploadingKind === "video"}
            onPick={(f) => uploadAsset("video", f)}
          />

          <div>
            <Label htmlFor="pitch-video-url">…or paste a video URL</Label>
            <Input
              id="pitch-video-url"
              type="url"
              value={videoUrl}
              onChange={(e) => setVideoUrl(e.target.value)}
              placeholder="https://www.loom.com/share/..."
            />
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
          <div className="flex items-center justify-between border-t border-white/10 pt-4">
            <Button
              variant="secondary"
              onClick={saveMeta}
              disabled={pending}
            >
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

function UploadRow({
  label,
  badge,
  accept,
  uploading,
  onPick,
}: {
  label: string;
  badge: string;
  accept: string;
  uploading: boolean;
  onPick: (f: File) => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-white/10 bg-zinc-950/40 px-3 py-3">
      <div>
        <div className="text-sm font-medium">{label}</div>
        <div className="text-xs text-white/50">{badge}</div>
      </div>
      <label className="inline-flex h-9 cursor-pointer items-center gap-2 rounded-lg bg-white/5 border border-white/10 px-3 text-xs font-medium text-white hover:bg-white/10">
        <Upload className="h-3.5 w-3.5" />
        {uploading ? "Uploading…" : "Choose file"}
        <input
          type="file"
          accept={accept}
          className="hidden"
          disabled={uploading}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onPick(f);
            e.target.value = "";
          }}
        />
      </label>
    </div>
  );
}
