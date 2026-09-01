"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
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
    // Deferred import keeps supabase-js out of the route's first-load JS.
    // Started here (not inside onTime) so the chunk is already in flight
    // before the first 10-second save comes due. A load failure surfaces
    // per save attempt; the noop handler keeps a never-played video from
    // logging an unhandled rejection nothing awaited.
    const clientModule = import("@/lib/supabase/client");
    clientModule.catch(() => {});
    const onTime = async () => {
      const seconds = Math.floor(v.currentTime);
      if (seconds - lastSavedRef.current < 10) return;
      lastSavedRef.current = seconds;
      // Saves are best-effort (results unchecked), so a missing client just
      // skips this tick rather than throwing out of the event listener.
      const mod = await clientModule.catch(() => null);
      if (!mod) return;
      const supabase = mod.createClient();
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
    let createClient;
    try {
      // The lazy chunk load can fail (offline, deploy skew) where the old
      // static import couldn't; release the button so the click can retry.
      ({ createClient } = await import("@/lib/supabase/client"));
    } catch {
      setSaving(false);
      return;
    }
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
      <div className="overflow-hidden rounded-2xl border border-line bg-paper aspect-video">
        {videoUrl ? (
          <video
            ref={videoRef}
            src={videoUrl}
            controls
            className="h-full w-full"
            playsInline
          />
        ) : (
          <div className="flex h-full items-center justify-center text-ink-faint text-sm">
            No video uploaded yet.
          </div>
        )}
      </div>
      <div className="mt-4 flex items-center justify-between">
        {completed ? (
          <span className="inline-flex items-center gap-2 text-sm text-emerald-700 dark:text-emerald-300">
            <CheckCircle2 className="h-4 w-4" /> Completed
          </span>
        ) : (
          <span className="text-sm text-ink-faint">Mark this lesson complete when you finish.</span>
        )}
        <Button onClick={markComplete} disabled={saving || completed} variant={completed ? "secondary" : "primary"}>
          {completed ? "Completed" : saving ? "Saving…" : "Mark complete"}
        </Button>
      </div>
    </div>
  );
}
