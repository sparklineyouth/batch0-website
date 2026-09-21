"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { PREMIERE_DRIFT_TOLERANCE_SECONDS } from "@/lib/webinars";
import { Loader2, PhoneOff, Play, RotateCcw } from "lucide-react";

/**
 * A premiere, as the audience sees it: a recording played on the clock.
 *
 * ---------------------------------------------------------------------------
 * Why the clock, and not the player, decides where everyone is
 * ---------------------------------------------------------------------------
 *
 * Every viewer is positioned at `serverNow - startsAt`, never at "wherever
 * playback happened to get to". That one decision is the whole illusion:
 * someone who opens the page twenty minutes late joins twenty minutes in, the
 * same way they would walk into a hall twenty minutes into a talk, rather than
 * watching the speaker say hello to a room that emptied out fifteen minutes
 * ago. It is what makes the event read as live instead of as a video file with
 * a start button.
 *
 * It is also the cheapest possible implementation of that illusion. There is no
 * per-viewer signalling, no host-driven "seek everyone to 12:31", no state for
 * a late joiner to be caught up with — the offset is arithmetic on a timestamp
 * both sides already have. A reload is self-healing for the same reason: the
 * page mounts a new player, asks the clock where the talk is, and drops the
 * viewer back exactly where the room is, with no memory of where they were.
 *
 * The offset arrives as a prop from the server (`premiereState()` in
 * lib/webinars.ts) and is never recomputed here from `Date.now()`. A laptop
 * whose clock is four minutes fast is not rare — it is the normal state of a
 * machine that has been asleep in a bag — and trusting it would sit that
 * student four minutes ahead of the room, hearing answers to questions the
 * chat has not asked yet.
 *
 * ---------------------------------------------------------------------------
 * What this component deliberately does NOT do
 * ---------------------------------------------------------------------------
 *
 *   - It does not pretend to be a video player. There are no controls, no
 *     scrubber, no playback-rate menu and no picture-in-picture, because all of
 *     those let a viewer leave the shared position, and a viewer who has
 *     scrubbed is watching a different event from everyone else in the Q&A.
 *     None of that is DRM and none of it is claimed to be — the signed URL is
 *     in the network tab of any browser. It is there so the room stays in sync,
 *     not to stop a determined student saving the file.
 *
 *   - It does not decide what happens when the recording ends. It reports
 *     `onRecordingFinished` and the page decides, because only the page knows
 *     whether a host is standing by. The name is deliberate and was changed
 *     from `onEnded`: when `qaOpensAt` is later than the recording is long,
 *     lib/webinars.ts holds the room on the last frame on purpose, so the end
 *     of the FILE is not the end of the premiere. A prop called `onEnded`
 *     invites the next reader to wire the handover to it and cut a room over
 *     to "this webinar has ended" minutes before the host is due to speak.
 *
 *   - It does not re-mint its own signed URL. It reports `onExpired` and the
 *     page hands back a fresh `src`. Minting is a server action with the
 *     event's permissions behind it, and this file has none.
 *
 *   - It knows nothing about the rest of the audience, which is the point of
 *     `audience_mode: 'private'`: there is no viewer count in here to leak and
 *     no per-viewer signal on the wire that could be counted from outside.
 */

/**
 * How many consecutive load failures before we stop asking the server for a
 * fresh URL and put a sentence and a button on screen instead. An expired
 * signature is fixed by the first re-mint; a deleted object or a dead CDN is
 * fixed by nobody, and a viewer staring at a black rectangle that never says
 * anything has no way to tell those apart from "my wifi is bad".
 */
const MAX_RECOVERY_ATTEMPTS = 3;

/** Floor between automatic re-mint requests. See `lastExpiryReport`. */
const REMINT_COOLDOWN_MS = 60_000;

export function PremierePlayer({
  src,
  offsetSeconds,
  durationSeconds,
  onExpired,
  onRecordingFinished,
  onLeave,
  title,
}: {
  /** Signed URL for the premiere video. Short-lived — see onExpired. */
  src: string;
  /** Server-authoritative. NEVER use Date.now() for the offset — a viewer whose
   *  laptop clock is four minutes fast would sit four minutes ahead of the room. */
  offsetSeconds: number;
  /** Length of the recording, from events.premiere_seconds. */
  durationSeconds: number;
  /** Re-mint the signed URL. Called when the <video> errors on an expired URL. */
  onExpired: () => void;
  /**
   * The RECORDING reached its end locally — not the premiere. The page treats
   * this as a hint to re-ask the server, because the room may deliberately sit
   * on the last frame until the host opens Q&A.
   */
  onRecordingFinished: () => void;
  /**
   * Leave the room for good. Optional only because some shells own the exit
   * themselves; the button is rendered either way — see the control bar below
   * for why a premiere must have one.
   */
  onLeave?: () => void;
  title: string;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);

  /**
   * Where the clock says the talk is, expressed as a fixed point plus elapsed
   * monotonic time.
   *
   * `performance.now()` and not `Date.now()`: this is the one place a wall
   * clock genuinely cannot be used, because it is not a clock at all but a
   * stopwatch. `Date.now()` steps when NTP corrects the machine, and it steps
   * by minutes on a laptop that has just woken from sleep — either of which
   * would show up here as a sudden "drift" of the same size and yank the
   * player somewhere it does not belong. `performance.now()` only ever moves
   * forward, at one second per second.
   *
   * `at` is not read during render, because a client component still renders
   * on the server, where `performance` is not the browser's. It starts at -1
   * as an explicit "not anchored yet" sentinel rather than 0: 0 is a real,
   * meaningful value on this stopwatch — the moment the document started — so
   * a 0 here would make `expectedNow()` return the offset PLUS the entire age
   * of the page. `loadedmetadata` genuinely can win the race against the mount
   * effect on a cached file, and when it did, a viewer who had the tab open
   * for half an hour before the premiere began was seeked past the end of the
   * recording and handed a finished webinar the instant it started.
   */
  const anchor = useRef({ offset: offsetSeconds, at: -1 });

  /**
   * Leaving is terminal for the media, and a ref rather than only state
   * because every media event handler below is a closure the element may call
   * after the click: `left` in state is stale inside them, and "I pressed
   * leave and the talk kept talking" is the one outcome this component must
   * never produce.
   */
  const leftRef = useRef(false);

  /** onRecordingFinished fires once per mount. `timeupdate` fires four times a second. */
  const endedOnce = useRef(false);

  /**
   * Last time we asked for a fresh URL, on the monotonic clock. A signed URL
   * expiring mid-talk is a real and expected failure with a real repair, but a
   * `src` that is broken for any other reason (deleted object, dead CDN) errors
   * again the instant the new one loads — so without a floor here the page
   * would re-mint in a tight loop for the rest of the hour.
   */
  const lastExpiryReport = useRef(0);

  /**
   * The re-mint the cooldown above refused, parked on a timer.
   *
   * Dropping it outright was a silent dead end: `error` only fires when the
   * element attempts a load, so a request suppressed by the cooldown is never
   * retried by anything — nothing else is going to fire. A URL that expired
   * shortly after a transient failure therefore left the viewer on a frozen
   * frame for the rest of the hour with no error, no retry and no clue.
   */
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Consecutive load failures, reset the moment frames actually play. */
  const failures = useRef(0);

  /**
   * Has playback ever actually settled? Until it has, every `waiting` we see is
   * the initial seek buffering, which is not a reconnection and must not be
   * labelled as one — telling a viewer the stream dropped one second after they
   * arrived is how a working webinar gets reported as broken.
   */
  const settled = useRef(false);

  const [needsGesture, setNeedsGesture] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const [left, setLeft] = useState(false);
  const [failed, setFailed] = useState(false);
  /** Bumped by Rejoin so the seek-and-play effect runs again on the same `src`. */
  const [resumeToken, setResumeToken] = useState(0);
  const leftCoverRef = useRef<HTMLDivElement>(null);

  /** Where the recording should be right now, clamped to its own length. */
  const expectedNow = useCallback(() => {
    // Before the anchor exists there is no elapsed time to add — only the
    // server's position is known, and that is the honest answer.
    const anchoredAt = anchor.current.at;
    const elapsed = anchoredAt < 0 ? 0 : (performance.now() - anchoredAt) / 1000;
    const target = anchor.current.offset + elapsed;
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      return Math.max(0, target);
    }
    // Never past the last frame: browsers disagree about a seek beyond the end
    // (some clamp, some fire `ended`, one seeks to zero and starts the talk
    // over in front of the whole audience).
    return Math.min(Math.max(0, target), Math.max(0, durationSeconds - 0.25));
  }, [durationSeconds]);

  /**
   * Re-anchor ONLY when the server hands us a new position.
   *
   * This effect used to depend on `src` as well, and that was a rewind
   * machine. A re-minted signed URL arrives with the same `offsetSeconds` the
   * page was rendered with — re-minting is a fresh signature on the same
   * object, not a fresh clock reading — so re-anchoring on it threw away a
   * stopwatch that had been running for twenty-five minutes and replaced it
   * with the position the viewer JOINED at. Every viewer in the room jumped
   * back to the start of the talk the moment a URL was refreshed, which is
   * precisely the failure the header at the top of this file claims to
   * prevent.
   */
  useEffect(() => {
    // The anchor is updated even while left — it is arithmetic, it touches no
    // media, and it is what a rejoiner is placed by. Only the seek below is
    // skipped, because seeking a departed element is how audio comes back.
    anchor.current = { offset: offsetSeconds, at: performance.now() };
    settled.current = false;
    const video = videoRef.current;
    if (!video || leftRef.current) return;
    // Metadata may already be loaded when only the offset changed and the
    // element kept its source; when it has not, `loadedmetadata` does this
    // instead. Seeking before the duration is known is a silent no-op in
    // Safari, which is why the seek lives in two places rather than one.
    if (video.readyState >= 1 /* HAVE_METADATA */) {
      video.currentTime = expectedNow();
    }
  }, [offsetSeconds, expectedNow]);

  /**
   * Start playing, and find out whether the browser will let us.
   *
   * A video carrying audio does not play without a user gesture. The viewer
   * usually has given one — they clicked Join in the green room, and that
   * gesture is still good for this page load — but a reload is not a gesture,
   * and neither is following a link straight into the room. On those paths
   * `play()` rejects, and without the overlay below the student sits looking at
   * a still frame with no controls and reasonably concludes the webinar is
   * broken. This is not a nicety; it is the difference between a room that
   * works on refresh and one that does not.
   */
  const attemptPlay = useCallback(() => {
    const video = videoRef.current;
    // Nothing may start audio after the viewer has left, whoever asks and for
    // whatever reason — a queued visibility change, a late `loadedmetadata`,
    // a re-render with a new URL.
    if (!video || leftRef.current) return;
    video
      .play()
      .then(() => setNeedsGesture(false))
      .catch(() => setNeedsGesture(true));
  }, []);

  const handleLoadedMetadata = useCallback(() => {
    const video = videoRef.current;
    if (!video || leftRef.current) return;
    video.currentTime = expectedNow();
    attemptPlay();
  }, [attemptPlay, expectedNow]);

  /**
   * The video paused and we did not ask it to.
   *
   * iOS Safari pauses an inline video that carries audio whenever the page
   * stops being visible — the viewer takes a call, answers a text, or locks
   * the phone twenty minutes into the talk. Coming back, the element is
   * paused, the `autoplay` attribute has already been spent, this component
   * renders no native controls, and the overlay that would offer to start it
   * again was dismissed on the way in. The room becomes a still frame with a
   * Leave button under it, and the student's only working move is to reload
   * and hope. Re-arming the gate gives them the one thing they need: a button
   * that starts the talk again, at the room's position rather than theirs.
   *
   * Guarded on the terminal states because both of those pause the element as
   * a matter of course, and neither is something to offer to resume: `ended`
   * is the recording holding on its last frame, and `left` is a viewer who
   * asked for silence.
   */
  const handlePause = useCallback(() => {
    const video = videoRef.current;
    if (!video || leftRef.current || endedOnce.current || video.ended) return;
    setNeedsGesture(true);
  }, []);

  /**
   * Drift correction, deliberately lazy.
   *
   * A `<video>` decoding on a busy machine falls behind the clock slowly, and
   * over forty minutes that adds up to something a viewer would notice against
   * a friend's screen. The fix is not to re-seek on every tick: a seek flushes
   * the decode pipeline, so a player corrected four times a second stutters
   * continuously, drops audio across each seek, and on Safari re-buffers for
   * roughly a second each time — which is a far worse experience than being a
   * second and a half behind, and a viewer can actually see it happening.
   *
   * So nothing happens at all until the error passes
   * PREMIERE_DRIFT_TOLERANCE_SECONDS, which lib/webinars.ts sets below the
   * threshold where two screens visibly disagree and well above the jitter of
   * an element that is simply playing.
   */
  const handleTimeUpdate = useCallback(() => {
    const video = videoRef.current;
    if (!video || leftRef.current) return;

    if (
      durationSeconds > 0 &&
      video.currentTime >= durationSeconds &&
      !endedOnce.current
    ) {
      endedOnce.current = true;
      onRecordingFinished();
      return;
    }

    // A seek already in flight will land where we last asked it to; asking
    // again mid-seek is how a player ends up chasing itself.
    if (video.seeking) return;

    const expected = expectedNow();
    if (Math.abs(video.currentTime - expected) > PREMIERE_DRIFT_TOLERANCE_SECONDS) {
      video.currentTime = expected;
    }
  }, [durationSeconds, expectedNow, onRecordingFinished]);

  const handleVideoEnded = useCallback(() => {
    if (endedOnce.current || leftRef.current) return;
    endedOnce.current = true;
    onRecordingFinished();
  }, [onRecordingFinished]);

  const requestFreshUrl = useCallback(() => {
    lastExpiryReport.current = performance.now();
    onExpired();
  }, [onExpired]);

  /**
   * A load failed. Ask for a new URL — later, if not now.
   *
   * The cooldown is still here for the reason it always was (a permanently
   * broken object errors again the instant a new URL loads, and without a
   * floor this re-mints in a tight loop for the rest of the hour), but the
   * suppressed request is now parked on a timer instead of being thrown away.
   * Dropping it meant the retry never happened at all: `error` only fires on a
   * load attempt, so once we declined to ask, nothing existed that would ever
   * ask again — a URL that expired shortly after one transient failure froze
   * the room permanently, in silence.
   *
   * And after a few rounds of that we stop and say so. A signature problem is
   * gone after the first re-mint; anything still failing on the fourth attempt
   * is a deleted object or a dead CDN, which no amount of re-minting repairs,
   * and a black rectangle that never speaks is indistinguishable from bad wifi
   * to the student sitting in front of it.
   */
  const handleError = useCallback(() => {
    if (leftRef.current) return;

    failures.current += 1;
    if (failures.current >= MAX_RECOVERY_ATTEMPTS) {
      if (retryTimer.current) {
        clearTimeout(retryTimer.current);
        retryTimer.current = null;
      }
      setBuffering(false);
      setFailed(true);
      return;
    }

    const now = performance.now();
    const sinceLast = lastExpiryReport.current
      ? now - lastExpiryReport.current
      : Number.POSITIVE_INFINITY;

    if (sinceLast < REMINT_COOLDOWN_MS) {
      if (retryTimer.current) return; // one queued retry is enough
      retryTimer.current = setTimeout(() => {
        retryTimer.current = null;
        if (leftRef.current) return;
        requestFreshUrl();
      }, REMINT_COOLDOWN_MS - sinceLast);
      return;
    }

    requestFreshUrl();
  }, [requestFreshUrl]);

  /** The viewer asking for the retry themselves, after we gave up. */
  const handleManualRetry = useCallback(() => {
    failures.current = 0;
    setFailed(false);
    setBuffering(false);
    requestFreshUrl();
    const video = videoRef.current;
    if (video) video.load();
  }, [requestFreshUrl]);

  // A parked retry must not outlive the component; a timer that fires into an
  // unmounted room re-mints a URL nobody is watching and warns in dev.
  useEffect(
    () => () => {
      if (retryTimer.current) {
        clearTimeout(retryTimer.current);
        retryTimer.current = null;
      }
    },
    [],
  );

  /**
   * End the call, and mean it.
   *
   * A premiere has no CallControls under it — there is no microphone and no
   * camera to toggle — and the `<video>` deliberately renders no native
   * controls, so without this button a viewer who needs to stop has nothing to
   * press at all: not pause, not mute, not close. Leaving therefore has to do
   * the work itself rather than only reporting upwards, because the page may
   * keep this mounted for a moment (or a parent may be mid-transition) and a
   * talk that keeps playing audio after someone said "leave" is the single most
   * alarming thing this component could do in a room full of students.
   *
   * `removeAttribute("src")` then `load()` is the order that actually stops the
   * network fetch; pausing alone leaves the browser downloading the rest of the
   * file. But clearing the element is not enough on its own, and that was the
   * bug: React still held `src={src}`, so the next time the page re-rendered —
   * a re-mint, a poll, any parent state change — React put the URL straight
   * back on the element, `autoPlay` did what it is named after, and the talk
   * resumed playing AUDIO behind the "you've left" cover. Hence `leftRef`,
   * which every handler above checks, and `src={left ? undefined : src}` on
   * the element, which is what makes leaving actually terminal.
   *
   * `history.back()` is the fallback when the shell owns no exit of its own,
   * matching what pre-join.tsx does with the same button.
   */
  const handleLeave = useCallback(() => {
    leftRef.current = true;
    const video = videoRef.current;
    if (video) {
      video.pause();
      video.removeAttribute("src");
      video.load();
    }
    if (retryTimer.current) {
      clearTimeout(retryTimer.current);
      retryTimer.current = null;
    }
    setLeft(true);
    setNeedsGesture(false);
    setBuffering(false);
    if (onLeave) onLeave();
    else if (typeof window !== "undefined") window.history.back();
  }, [onLeave]);

  /**
   * Back in, from the cover.
   *
   * `history.back()` is a no-op in a tab that has no history to go back to,
   * and that is the ordinary way into this room rather than an edge case: a
   * Discord link and a calendar .ics both open the webinar in a fresh tab. A
   * viewer who pressed Leave there — by accident, or because they meant to
   * step away for a minute — was left holding a dead black rectangle with no
   * way back short of finding the link again mid-webinar.
   *
   * Rejoining deliberately does not restore a position: the token below makes
   * the seek effect run again, and the viewer lands where the ROOM is now, the
   * same as any other late arrival.
   */
  const handleRejoin = useCallback(() => {
    leftRef.current = false;
    failures.current = 0;
    settled.current = false;
    // The anchor is untouched on purpose: the stopwatch never stopped, so it
    // still says where the room is, which is where a rejoiner belongs.
    setFailed(false);
    setLeft(false);
    setResumeToken((n) => n + 1);
  }, []);

  /**
   * A new `src` (or a rejoin) means: re-seek and play — and DO NOT touch the
   * anchor, which belongs to the effect above. Seeking is safe here because
   * `expectedNow()` is read from the running stopwatch, so a viewer handed a
   * refreshed URL lands exactly where they were rather than where they joined.
   *
   * Autoplay is attempted here and not only from `loadedmetadata`: a cached
   * video can be past HAVE_METADATA before React attaches the handler, and
   * that path would otherwise never try to play at all.
   */
  useEffect(() => {
    if (leftRef.current) return;
    const video = videoRef.current;
    if (!video || video.readyState < 1 /* HAVE_METADATA */) return;
    video.currentTime = expectedNow();
    attemptPlay();
  }, [attemptPlay, expectedNow, src, resumeToken]);

  /**
   * Coming back to the tab.
   *
   * The pause handler above re-arms the gate, but a viewer returning to a
   * webinar should not have to press anything at all in the common case, and
   * more importantly the element is now minutes behind the room: it stopped
   * where the phone locked while the clock kept going. Seek first, then play,
   * so they rejoin at the room's position instead of resuming a talk everyone
   * else finished listening to.
   */
  useEffect(() => {
    if (typeof document === "undefined") return;
    const onVisibility = () => {
      if (document.visibilityState !== "visible") return;
      const video = videoRef.current;
      if (!video || leftRef.current || endedOnce.current || video.ended) return;
      if (video.readyState >= 1 /* HAVE_METADATA */) {
        video.currentTime = expectedNow();
      }
      attemptPlay();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [attemptPlay, expectedNow]);

  // Focus follows the cover, so a keyboard or screen-reader user who presses
  // Leave is not left on a button that no longer exists with their focus reset
  // to the top of the document — and so Rejoin is one Tab away, not twenty.
  useEffect(() => {
    if (left) leftCoverRef.current?.focus();
  }, [left]);

  return (
    <section
      aria-label={`${title} — premiere`}
      className="relative isolate aspect-video w-full max-w-full overflow-hidden rounded-xl border border-line bg-ink-900"
    >
      <video
        ref={videoRef}
        // Not `src` while left: React would otherwise re-attach the URL on the
        // next parent render and `autoPlay` would start the talk again behind
        // the cover, audible, after the viewer explicitly ended the call.
        src={left ? undefined : src}
        autoPlay
        playsInline
        preload="auto"
        // No native controls anywhere: no scrubber to leave the room's position
        // with, no download item and no playback-rate menu in the context menu,
        // and no picture-in-picture window that would keep playing after the
        // page moves on to the live Q&A.
        controlsList="nodownload noplaybackrate"
        disablePictureInPicture
        onContextMenu={(e) => e.preventDefault()}
        onLoadedMetadata={handleLoadedMetadata}
        onTimeUpdate={handleTimeUpdate}
        onEnded={handleVideoEnded}
        onError={handleError}
        onPause={handlePause}
        onWaiting={() => {
          if (settled.current && !leftRef.current) setBuffering(true);
        }}
        onPlaying={() => {
          settled.current = true;
          // Frames are arriving: whatever was broken is not broken now, so the
          // failure counter must start over. Without this reset, three
          // unrelated blips spread across a ninety-minute premiere would add
          // up to a permanent "we couldn't load this" on a stream that is
          // playing perfectly well.
          failures.current = 0;
          setFailed(false);
          setBuffering(false);
          setNeedsGesture(false);
        }}
        className="h-full w-full object-cover"
      />

      {/*
        The gesture gate. A real <button> rather than a click handler on the
        frame, because it is the only interactive thing on this screen and it
        has to be reachable by keyboard and announced by a screen reader — and
        because a bare div here would be a control that a student using
        VoiceOver simply cannot find.
      */}
      {needsGesture && !left && !failed && (
        <div className="absolute inset-0 grid place-items-center bg-ink-900/80 px-6">
          <div className="text-center">
            <button
              type="button"
              onClick={attemptPlay}
              className="inline-flex h-12 select-none items-center justify-center gap-2 rounded-md bg-phosphor px-6 text-base font-semibold leading-none text-on-phosphor shadow-cta transition-colors hover:bg-phosphor-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-phosphor focus-visible:ring-offset-2 focus-visible:ring-offset-ink-900 active:scale-[0.98]"
            >
              <Play className="h-4 w-4" />
              Tap to join the stream
            </button>
            <p className="mt-3 text-xs text-[#fff]/70">
              The sound is paused until you ask for it. You&rsquo;ll join
              exactly where everyone else is — not where you left off.
            </p>
          </div>
        </div>
      )}

      {/*
        Buffering, phrased as the viewer experiences it. "Reconnecting" is a lie
        in the strict sense — nothing has disconnected, a segment is late — but
        it is the true sentence for what they should do about it, which is wait
        a moment rather than reload and lose their place in the room.
      */}
      {buffering && !needsGesture && !left && !failed && (
        // role/aria-live so a screen-reader user is told the picture stalled.
        // Without it the only signal that anything is happening is a spinner,
        // which is exactly nothing to a student listening rather than looking.
        <div
          role="status"
          aria-live="polite"
          className="absolute inset-0 grid place-items-center bg-ink-900/60"
        >
          <div className="text-center">
            <Loader2 className="mx-auto h-6 w-6 animate-spin text-[#fff]/80" />
            <p className="mt-3 text-sm font-medium text-[#fff]">Reconnecting&hellip;</p>
          </div>
        </div>
      )}

      {/*
        We gave up re-minting. Say so in a plain sentence and give them a
        button, because the alternative — the state this used to reach — is a
        silent black rectangle that a student cannot tell apart from their own
        connection, and which will never try again on its own.
      */}
      {failed && !left && (
        <div
          role="status"
          aria-live="polite"
          className="absolute inset-0 grid place-items-center bg-ink-900 px-6"
        >
          <div className="text-center">
            <p className="text-sm font-medium text-[#fff]">
              We couldn&rsquo;t load the stream.
            </p>
            <p className="mx-auto mt-2 max-w-sm text-xs text-[#fff]/70">
              The webinar is still running. Try again, and you&rsquo;ll rejoin
              wherever the room has got to.
            </p>
            <button
              type="button"
              onClick={handleManualRetry}
              className="mt-4 inline-flex h-10 select-none items-center justify-center gap-2 rounded-md bg-phosphor px-5 text-sm font-semibold leading-none text-on-phosphor shadow-cta transition-colors hover:bg-phosphor-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-phosphor focus-visible:ring-offset-2 focus-visible:ring-offset-ink-900 active:scale-[0.98]"
            >
              <RotateCcw className="h-4 w-4" />
              Try again
            </button>
          </div>
        </div>
      )}

      {/*
        The end-of-call screen. `role="status"` and a focus target because
        pressing Leave destroys the button that had focus, and a keyboard user
        would otherwise be dropped at the top of the document with nothing
        announced — told neither that the call ended nor that there is a way
        back into it.
      */}
      {left && (
        <div
          ref={leftCoverRef}
          role="status"
          aria-live="polite"
          tabIndex={-1}
          className="absolute inset-0 grid place-items-center bg-ink-900 px-6 focus:outline-none"
        >
          <div className="text-center">
            <p className="text-sm font-medium text-[#fff]">
              You&rsquo;ve left the stream.
            </p>
            <button
              type="button"
              onClick={handleRejoin}
              className="mt-4 inline-flex h-10 select-none items-center justify-center gap-2 rounded-md bg-phosphor px-5 text-sm font-semibold leading-none text-on-phosphor shadow-cta transition-colors hover:bg-phosphor-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-phosphor focus-visible:ring-offset-2 focus-visible:ring-offset-ink-900 active:scale-[0.98]"
            >
              <Play className="h-4 w-4" />
              Rejoin the stream
            </button>
          </div>
        </div>
      )}

      {/*
        Same footer chrome as VideoTile, on purpose. A premiere sits in exactly
        the frame a live host would, and the moment the recording hands over to
        the real Q&A the only thing that changes on screen is the picture — if
        this frame had its own look, the handover would read as a page change
        and half the room would think the talk had ended.

        The whole footer goes when the viewer leaves, not just the button
        inside it: both it and the cover are absolutely positioned siblings, so
        the later one paints on top, and the title strip with its "live" tag
        was drawing over the "you've left" screen — telling someone who just
        ended the call that they are still watching a live webinar.
      */}
      {!left && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-between gap-2 bg-gradient-to-t from-black/70 to-transparent px-3 pb-2 pt-6">
          <span className="truncate text-xs font-medium text-[#fff]">
            {title}
            <span className="ml-1.5 font-mono text-[10px] uppercase tracking-wider text-[#fff]/60">
              live
            </span>
          </span>

          {/*
            The exit, inside the frame because there is nothing else under it to
            put a control bar in. Styled as the Leave button in call-controls.tsx
            so a viewer who has been in a batch0 room before recognises it without
            reading it. `pointer-events-auto` re-enables clicks that the gradient
            above gives up.
          */}
          <button
            type="button"
            onClick={handleLeave}
            aria-label="Leave the stream"
            className="pointer-events-auto inline-flex h-8 shrink-0 select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-md bg-red-500 px-3 text-xs font-semibold leading-none text-[#fff] transition-colors hover:bg-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-phosphor focus-visible:ring-offset-2 focus-visible:ring-offset-ink-900 active:scale-[0.98]"
          >
            <PhoneOff className="h-3.5 w-3.5" />
            Leave
          </button>
        </div>
      )}
    </section>
  );
}
