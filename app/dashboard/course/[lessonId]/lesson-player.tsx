"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { CheckCircle2 } from "lucide-react";
import { formatPlayhead, resumePosition, shouldSavePosition } from "@/lib/lesson-assets";

type SupabaseBrowser = ReturnType<typeof import("@/lib/supabase/client").createClient>;

/** Re-asking the video route more often than this means it isn't expiry. */
const RECOVERY_WINDOW_MS = 60_000;
const MAX_RECOVERIES_IN_WINDOW = 3;

export function LessonPlayer({
  lessonId,
  videoSrc,
  refreshable,
  resumeAt,
  completed: initialCompleted,
}: {
  lessonId: string;
  videoSrc: string | null;
  /** videoSrc is the signing route (not an external URL), so asking it again gets a fresh signature. */
  refreshable: boolean;
  /** The saved second to pick up from (0 = from the start), already through resumePosition(). */
  resumeAt: number;
  completed: boolean;
}) {
  const router = useRouter();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [completed, setCompleted] = useState(initialCompleted);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [src, setSrc] = useState(videoSrc);
  const [resumedAt, setResumedAt] = useState<number | null>(null);
  const [videoError, setVideoError] = useState<string | null>(null);
  // The second last written to lesson_progress. Starts at the resume point,
  // so seeking there isn't itself "a move worth saving".
  const lastSavedRef = useRef(resumeAt);
  // Where the playhead was at the last timeupdate — what a reload of an
  // expired source seeks back to (the element may have reset by then).
  const lastTimeRef = useRef(resumeAt);
  // A seek waiting for the file's metadata: the first load's resume, or the
  // spot a refreshed source picks up from.
  const pendingSeekRef = useRef<{ at: number; kind: "resume" | "recover"; play: boolean } | null>(
    resumeAt > 0 ? { at: resumeAt, kind: "resume", play: false } : null,
  );
  const playingRef = useRef(false);
  const recoveriesRef = useRef<number[]>([]);

  // Persist the playhead: every ~10 seconds of movement while playing, and
  // whenever it stops (pause, the tab hidden, the page closing).
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    // Deferred import keeps supabase-js out of the route's first-load JS.
    // Started here (not inside a handler) so the chunk is already in flight
    // before the first save comes due. A load failure surfaces per save
    // attempt; the noop handler keeps a never-played video from logging an
    // unhandled rejection nothing awaited.
    const clientModule = import("@/lib/supabase/client");
    clientModule.catch(() => {});
    let client: SupabaseBrowser | null = null;
    let userId: string | null = null;

    // Saves are best-effort (results unchecked): a missing client or session
    // just skips this one rather than throwing out of an event listener.
    const save = async (flush: boolean) => {
      // Until a pending seek lands the element sits at 0 (a fresh load
      // resets it), and writing that would wipe the place being resumed.
      if (pendingSeekRef.current) return;
      const seconds = Math.floor(v.currentTime);
      if (!shouldSavePosition(seconds, lastSavedRef.current, flush)) return;
      lastSavedRef.current = seconds;
      const mod = await clientModule.catch(() => null);
      if (!mod) return;
      client ??= mod.createClient();
      if (!userId) {
        // Once per page: the session is local, and RLS still checks the
        // row's user_id against the token on every write.
        const { data } = await client.auth.getSession();
        userId = data.session?.user.id ?? null;
        if (!userId) return;
      }
      await client.from("lesson_progress").upsert(
        { user_id: userId, lesson_id: lessonId, watched_seconds: seconds },
        { onConflict: "user_id,lesson_id" },
      );
    };

    const onTime = () => {
      if (pendingSeekRef.current) return;
      lastTimeRef.current = v.currentTime;
      void save(false);
    };
    const onPlay = () => {
      playingRef.current = true;
    };
    const onPause = () => {
      playingRef.current = false;
      void save(true);
    };
    const onHidden = () => {
      if (document.visibilityState === "hidden") void save(true);
    };
    const onLeave = () => void save(true);

    v.addEventListener("timeupdate", onTime);
    v.addEventListener("play", onPlay);
    v.addEventListener("pause", onPause);
    document.addEventListener("visibilitychange", onHidden);
    window.addEventListener("pagehide", onLeave);
    return () => {
      v.removeEventListener("timeupdate", onTime);
      v.removeEventListener("play", onPlay);
      v.removeEventListener("pause", onPause);
      document.removeEventListener("visibilitychange", onHidden);
      window.removeEventListener("pagehide", onLeave);
    };
  }, [lessonId]);

  // Seek once the file's length is known: the saved spot on first load (re-
  // checked against the real duration — the lesson row may not record one),
  // or where playback was when an expired source had to be fetched again.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onMeta = () => {
      const pending = pendingSeekRef.current;
      if (!pending) return;
      pendingSeekRef.current = null;
      const at =
        pending.kind === "resume"
          ? resumePosition(pending.at, v.duration)
          : Math.min(pending.at, Number.isFinite(v.duration) ? Math.max(0, v.duration - 1) : pending.at);
      if (at > 0) v.currentTime = at;
      lastTimeRef.current = at;
      if (pending.kind === "resume" && at > 0) setResumedAt(at);
      if (pending.play) void v.play().catch(() => {});
    };
    v.addEventListener("loadedmetadata", onMeta);
    // Metadata can arrive before hydration attaches the listener.
    if (v.readyState >= 1) onMeta();
    return () => v.removeEventListener("loadedmetadata", onMeta);
  }, [src]);

  // The signature on the file can run out mid-video (or a connection drop
  // can kill the stream): ask the route for a fresh one and carry on from
  // the same second. Repeated failures in a short window aren't expiry —
  // stop and say so instead of looping.
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !refreshable || !videoSrc) return;
    const onError = () => {
      const code = v.error?.code;
      // 1 = aborted by the user/browser; 3 = the file itself won't decode.
      if (code === 1 || code === 3) return;
      const now = Date.now();
      const recent = recoveriesRef.current.filter((t) => now - t < RECOVERY_WINDOW_MS);
      if (recent.length >= MAX_RECOVERIES_IN_WINDOW) {
        recoveriesRef.current = recent;
        setVideoError("The video couldn't load. Reload the page to try again — if it keeps happening, tell the team in Support.");
        return;
      }
      recoveriesRef.current = [...recent, now];
      pendingSeekRef.current = { at: lastTimeRef.current, kind: "recover", play: playingRef.current };
      const sep = videoSrc.includes("?") ? "&" : "?";
      setSrc(`${videoSrc}${sep}r=${now}`);
    };
    v.addEventListener("error", onError);
    // The server-rendered element starts loading before hydration, so a
    // first request that failed fast has already fired its event.
    if (v.error) onError();
    return () => v.removeEventListener("error", onError);
  }, [refreshable, videoSrc]);

  function startOver() {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = 0;
    lastTimeRef.current = 0;
    setResumedAt(null);
  }

  async function markComplete() {
    setSaving(true);
    setError(null);
    try {
      // The lazy chunk load can fail (offline, deploy skew) where the old
      // static import couldn't; release the button so the click can retry.
      const { createClient } = await import("@/lib/supabase/client");
      const supabase = createClient();
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        throw new Error("Sign in again to save your progress.");
      }
      const { error: saveError } = await supabase.from("lesson_progress").upsert(
        {
          user_id: user.id,
          lesson_id: lessonId,
          watched_seconds: Math.floor(videoRef.current?.currentTime ?? 0),
          completed_at: new Date().toISOString(),
        },
        { onConflict: "user_id,lesson_id" },
      );
      if (saveError) throw new Error("Your progress could not be saved. Please try again.");
      setCompleted(true);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Your progress could not be saved. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      {src && (
        <div className="overflow-hidden rounded-2xl border border-line bg-paper aspect-video">
          <video
            ref={videoRef}
            src={src}
            controls
            className="h-full w-full"
            playsInline
          />
        </div>
      )}
      {resumedAt !== null && !videoError && (
        <p className="mt-2 text-xs text-ink-faint">
          Picked up where you left off, at {formatPlayhead(resumedAt)}.{" "}
          <button type="button" onClick={startOver} className="text-phosphor-ink underline">
            Start over
          </button>
        </p>
      )}
      {videoError && (
        <p role="alert" className="mt-2 text-sm text-red-600 dark:text-red-400">
          {videoError}
        </p>
      )}
      <div className="mt-4 flex items-center justify-between">
        {completed ? (
          <span className="inline-flex items-center gap-2 text-sm text-emerald-700 dark:text-emerald-300">
            <CheckCircle2 className="h-4 w-4" /> Completed
          </span>
        ) : (
          <span className="text-sm text-ink-faint">{src ? "Mark this lesson complete when you finish." : "Finish the reading and exercises, then save your progress."}</span>
        )}
        <Button onClick={markComplete} disabled={saving || completed} variant={completed ? "secondary" : "primary"}>
          {completed ? "Completed" : saving ? "Saving…" : "Mark complete"}
        </Button>
      </div>
      {error && <p role="alert" className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}
