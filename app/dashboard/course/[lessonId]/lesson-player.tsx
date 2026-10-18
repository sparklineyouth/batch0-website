"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { CheckCircle2 } from "lucide-react";
import {
  RESUME_READ_TIMEOUT_MS,
  formatPlayhead,
  latestSavedSeconds,
  resumePosition,
  shouldSavePosition,
  videoErrorAction,
} from "@/lib/lesson-assets";

type SupabaseBrowser = ReturnType<typeof import("@/lib/supabase/client").createClient>;
type BrowserSession = { client: SupabaseBrowser; userId: string };

/** Re-asking the video route more often than this means it isn't expiry. */
const RECOVERY_WINDOW_MS = 60_000;
const MAX_RECOVERIES_IN_WINDOW = 3;

const VIDEO_UNAVAILABLE =
  "The video couldn't load. Reload the page to try again — if it keeps happening, tell the team in Support.";
const VIDEO_UNPLAYABLE =
  "This video won't play here — it may be in a format this browser can't play, or it couldn't be loaded. Reload to try again, or try another browser; if it keeps happening, tell the team in Support.";

export function LessonPlayer({
  lessonId,
  videoSrc,
  refreshable,
  savedSeconds,
  completed: initialCompleted,
}: {
  lessonId: string;
  videoSrc: string | null;
  /** videoSrc is the signing route (not an external URL), so asking it again gets a fresh signature. */
  refreshable: boolean;
  /**
   * lesson_progress.watched_seconds as the page read it — as saved, with no
   * rules applied: only the player knows the file's real length. May be the
   * router cache's old copy (Back/Forward), so the player reads it again.
   */
  savedSeconds: number;
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
  // The second last written to lesson_progress, as far as this page knows.
  // Set to wherever the resume lands, so a video nobody touches never writes:
  // a resume skipped as "nearly finished" must not then save 0 over the real
  // position just because the tab was hidden.
  const lastSavedRef = useRef(0);
  // Where the playhead was at the last timeupdate — what a reload of an
  // expired source seeks back to (the element may have reset by then).
  const lastTimeRef = useRef(0);
  // A seek waiting to happen. The resume waits for two things: the file's
  // metadata (its real duration) and the player's own read of the saved
  // second. A refreshed source's "recover" waits for metadata only. Saves are
  // held while one is pending: the element sits at 0 until it lands.
  const pendingSeekRef = useRef<{ at: number; kind: "resume" | "recover"; play: boolean } | null>(
    videoSrc ? { at: savedSeconds, kind: "resume", play: false } : null,
  );
  const resumeReadRef = useRef(false);
  const playingRef = useRef(false);
  const recoveriesRef = useRef<number[]>([]);
  // The file has loaded its metadata on this page at least once, so this
  // browser can play its format (videoErrorAction).
  const loadedRef = useRef(false);
  const sessionRef = useRef<Promise<BrowserSession | null> | null>(null);

  /**
   * The browser Supabase client and the signed-in id, once per page.
   * Deferred import keeps supabase-js out of the route's first-load JS; the
   * resume read below starts it at mount, so it's in flight before the first
   * save comes due. The session is local, and RLS still checks the row's
   * user_id against the token on every read and write. A failure isn't kept:
   * the next caller tries again.
   */
  function browserSession(): Promise<BrowserSession | null> {
    sessionRef.current ??= (async () => {
      const mod = await import("@/lib/supabase/client");
      const client = mod.createClient();
      const { data } = await client.auth.getSession();
      const userId = data.session?.user.id ?? null;
      return userId ? { client, userId } : null;
    })()
      .catch(() => null)
      .then((s) => {
        if (!s) sessionRef.current = null;
        return s;
      });
    return sessionRef.current;
  }

  /** Seek to the saved spot once the read is in and the file's length is known. */
  function applyResume() {
    const v = videoRef.current;
    const pending = pendingSeekRef.current;
    if (!v || pending?.kind !== "resume" || !resumeReadRef.current || v.readyState < 1) return;
    pendingSeekRef.current = null;
    // Against the real duration — the lesson row may not record one, or
    // record it wrong.
    const at = resumePosition(pending.at, v.duration);
    if (at > 0) v.currentTime = at;
    lastTimeRef.current = at;
    lastSavedRef.current = at;
    if (at > 0) setResumedAt(at);
    if (pending.play) void v.play().catch(() => {});
  }

  // The saved second as it stands now, not as the page was first rendered:
  // Back/Forward replays the first visit's payload. Waits RESUME_READ_TIMEOUT_MS
  // at most, then goes with the page's.
  useEffect(() => {
    if (!videoSrc) return;
    let done = false;
    const finish = (fromRead: number | null) => {
      if (done) return;
      done = true;
      const pending = pendingSeekRef.current;
      if (pending?.kind === "resume") {
        pendingSeekRef.current = { ...pending, at: latestSavedSeconds(savedSeconds, fromRead) };
      }
      resumeReadRef.current = true;
      applyResume();
    };
    const timer = window.setTimeout(() => finish(null), RESUME_READ_TIMEOUT_MS);
    void (async () => {
      const s = await browserSession();
      if (!s) return finish(null);
      const { data, error } = await s.client
        .from("lesson_progress")
        .select("watched_seconds")
        .eq("user_id", s.userId)
        .eq("lesson_id", lessonId)
        .maybeSingle();
      finish(error ? null : Number(data?.watched_seconds ?? 0));
    })().catch(() => finish(null));
    return () => {
      done = true;
      window.clearTimeout(timer);
    };
    // Refs and stable setters only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lessonId, videoSrc, savedSeconds]);

  // Persist the playhead: every ~10 seconds of movement while playing, and
  // whenever it stops (pause, the tab hidden, the page closing).
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;

    // Saves are best-effort (results unchecked): a missing client or session
    // just skips this one rather than throwing out of an event listener.
    const save = async (flush: boolean) => {
      // Until a pending seek lands the element sits at 0 (a fresh load
      // resets it), and writing that would wipe the place being resumed.
      if (pendingSeekRef.current) return;
      const seconds = Math.floor(v.currentTime);
      if (!shouldSavePosition(seconds, lastSavedRef.current, flush)) return;
      lastSavedRef.current = seconds;
      const s = await browserSession();
      if (!s) return;
      await s.client.from("lesson_progress").upsert(
        { user_id: s.userId, lesson_id: lessonId, watched_seconds: seconds },
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lessonId]);

  // Seek once the file's length is known: the saved spot on first load (via
  // applyResume, which also waits for the read above), or where playback was
  // when an expired source had to be fetched again.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onMeta = () => {
      loadedRef.current = true;
      const pending = pendingSeekRef.current;
      if (!pending) return;
      if (pending.kind === "resume") return applyResume();
      pendingSeekRef.current = null;
      const at = Math.min(pending.at, Number.isFinite(v.duration) ? Math.max(0, v.duration - 1) : pending.at);
      if (at > 0) v.currentTime = at;
      lastTimeRef.current = at;
      if (pending.play) void v.play().catch(() => {});
    };
    v.addEventListener("loadedmetadata", onMeta);
    // Metadata can arrive before hydration attaches the listener.
    if (v.readyState >= 1) onMeta();
    return () => v.removeEventListener("loadedmetadata", onMeta);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  // The signature on the file can run out mid-video (or a connection drop
  // can kill the stream): ask the route for a fresh one and carry on from
  // the same second. Repeated failures in a short window aren't expiry —
  // stop and say so instead of looping. A source the browser can't play at
  // all isn't expiry either, and says so at once (videoErrorAction).
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !refreshable || !videoSrc) return;
    const onError = () => {
      const action = videoErrorAction(v.error?.code, loadedRef.current);
      if (action === "ignore") return;
      if (action === "unplayable") {
        setVideoError(VIDEO_UNPLAYABLE);
        return;
      }
      const now = Date.now();
      const recent = recoveriesRef.current.filter((t) => now - t < RECOVERY_WINDOW_MS);
      if (recent.length >= MAX_RECOVERIES_IN_WINDOW) {
        recoveriesRef.current = recent;
        setVideoError(VIDEO_UNAVAILABLE);
        return;
      }
      recoveriesRef.current = [...recent, now];
      // A resume that hasn't happened yet still should, on the new source.
      if (pendingSeekRef.current?.kind !== "resume") {
        pendingSeekRef.current = { at: lastTimeRef.current, kind: "recover", play: playingRef.current };
      }
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
