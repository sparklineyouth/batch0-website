"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { CheckCircle2 } from "lucide-react";

export function LessonPlayer({
  lessonId,
  videoUrl,
  completed: initialCompleted,
}: {
  lessonId: string;
  videoUrl: string | null;
  completed: boolean;
}) {
  const router = useRouter();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [completed, setCompleted] = useState(initialCompleted);
  const [saving, setSaving] = useState(false);
  const lastSavedRef = useRef(0);

  // Persist watch progress every ~10 seconds
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const supabase = createClient();
    const onTime = async () => {
      const seconds = Math.floor(v.currentTime);
      if (seconds - lastSavedRef.current < 10) return;
      lastSavedRef.current = seconds;
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      await supabase.from("lesson_progress").upsert(
        {
          user_id: user.id,
          lesson_id: lessonId,
          watched_seconds: seconds,
        },
        { onConflict: "user_id,lesson_id" },
      );
    };
    v.addEventListener("timeupdate", onTime);
    return () => v.removeEventListener("timeupdate", onTime);
  }, [lessonId]);

  async function markComplete() {
    setSaving(true);
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      setSaving(false);
      return;
    }
    await supabase.from("lesson_progress").upsert(
      {
        user_id: user.id,
        lesson_id: lessonId,
        watched_seconds: Math.floor(videoRef.current?.currentTime ?? 0),
        completed_at: new Date().toISOString(),
      },
      { onConflict: "user_id,lesson_id" },
    );
    setCompleted(true);
    setSaving(false);
    router.refresh();
  }

  return (
    <div>
      <div className="overflow-hidden rounded-2xl border border-white/10 bg-black aspect-video">
        {videoUrl ? (
          <video
            ref={videoRef}
            src={videoUrl}
            controls
            className="h-full w-full"
            playsInline
          />
        ) : (
          <div className="flex h-full items-center justify-center text-white/40 text-sm">
            No video uploaded yet.
          </div>
        )}
      </div>
      <div className="mt-4 flex items-center justify-between">
        {completed ? (
          <span className="inline-flex items-center gap-2 text-sm text-emerald-300">
            <CheckCircle2 className="h-4 w-4" /> Completed
          </span>
        ) : (
          <span className="text-sm text-white/40">Mark this lesson complete when you finish.</span>
        )}
        <Button onClick={markComplete} disabled={saving || completed} variant={completed ? "secondary" : "primary"}>
          {completed ? "Completed" : saving ? "Saving…" : "Mark complete"}
        </Button>
      </div>
    </div>
  );
}
