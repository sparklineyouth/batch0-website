"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { getActionError } from "@/lib/action-error";
import {
  RECORDING_AUDIO_BITRATE,
  RECORDING_FPS,
  RECORDING_SEGMENT_SECONDS,
  RECORDING_VIDEO_BITRATE,
} from "@/lib/webinars";
import { callInsetBoxes, callTileBoxes } from "@/lib/call-recording";

/**
 * Recording a webinar from inside the host's tab.
 *
 * There is no server in the media path — batch0 Live is browser-to-browser
 * (see the topology note at the top of lib/live-signal.ts), so nothing but the
 * host's own machine ever sees the composed picture. That makes the host's tab
 * the only place a recording can be made, and it means every failure mode here
 * is a failure mode of a laptop that is *also* encoding and uploading live
 * video to thirty students at the same time. Everything below is shaped by
 * that: the recorder is built to cost as little as possible and to lose as
 * little as possible when it does break.
 *
 * ---------------------------------------------------------------------------
 * Why segments, and not one file at the end
 * ---------------------------------------------------------------------------
 *
 * The obvious implementation holds one `MediaRecorder` open for the whole hour
 * and pushes a single blob when the host hangs up. It fails three ways, and all
 * three land at the worst possible moment:
 *
 *   - memory grows for the entire webinar, so the tab is at its heaviest
 *     exactly when the host has been broadcasting longest;
 *   - the upload starts the instant the talk ends — several hundred megabytes,
 *     beginning at the moment the host wants to shut the laptop and leave;
 *   - and any failure anywhere in that hour costs the whole recording. A tab
 *     crash at minute fifty-five is fifty-five minutes of a guest speaker's
 *     time, gone, with nothing to re-run.
 *
 * So this writes a self-contained file every `RECORDING_SEGMENT_SECONDS` and
 * hands it straight to `onSegment`, which uploads it while the webinar is still
 * running. Memory is bounded by one segment. A crash costs the segment in
 * flight, not the hour behind it. The talk is fully uploaded seconds after it
 * ends rather than ten minutes later.
 *
 * The cost is a seam — tens of milliseconds every two minutes — because a
 * `MediaRecorder` has to be stopped and restarted for each file to carry its
 * own header and be independently playable. A segment that is only playable
 * when concatenated with its neighbours is not a safeguard against losing one;
 * it is a way to lose all of them together.
 *
 * ---------------------------------------------------------------------------
 * Why a canvas sits between the cameras and the recorder
 * ---------------------------------------------------------------------------
 *
 * The host's picture CHANGES mid-webinar. They open on camera, share slides
 * ten minutes in, drop back to camera for questions. A `MediaRecorder` bound to
 * a track ends when that track does, so a recorder pointed at the camera stops
 * dead the first time the host presents — and the failure is silent, because
 * the webinar itself carries on perfectly (the wire swaps tracks with
 * `replaceTrack`, which is precisely what a recorder cannot do).
 *
 * So nothing here is bound to a source track. Both sources are drawn into one
 * `<canvas>` — screen if presenting, camera otherwise, camera as a small inset
 * while presenting — and `canvas.captureStream()` yields ONE video track that
 * outlives every switch. The recorder never sees a track end, because from its
 * point of view nothing ever changed.
 *
 * ---------------------------------------------------------------------------
 * What this deliberately does not do
 * ---------------------------------------------------------------------------
 *
 * It does not record the audience: there is no audience media to record. A
 * viewer is receive-only by construction, so the recording is the broadcast,
 * and a student cannot end up on tape by turning on a microphone they were
 * never given. In a webinar it does not record remote broadcasters either — a
 * co-host's inbound video is not composed in, because that would put a second
 * person's camera into a file the first person believes is theirs.
 *
 * ---------------------------------------------------------------------------
 * The 1:1 exception, and why it is opt-in
 * ---------------------------------------------------------------------------
 *
 * A 1:1 call is the one room where the other person IS the recording: half a
 * conversation is not a record of it. So a caller that passes `remotes` gets a
 * different machine, fixed at `start()`:
 *
 *   - the picture is everyone side by side (or, while someone presents, their
 *     screen with each face as an inset), each labelled with their name, drawn
 *     from off-screen `<video>` elements fed the inbound streams;
 *   - the sound is MIXED. A `MediaRecorder` records one audio track, and a
 *     conversation is two microphones, so both are routed through an
 *     `AudioContext` into one `MediaStreamAudioDestinationNode` whose single
 *     track is what gets recorded. That track outlives every change underneath
 *     it — the other person arriving, dropping, rejoining, a device switch —
 *     for the same reason the canvas does: the recorder never sees a source
 *     track end.
 *
 * Both people are told, in the green room and in the room, before a frame is
 * written (broadcast-room.tsx). A webinar passes no `remotes` and records
 * exactly what it always has.
 *
 * It also never retries an upload. `onSegment` owns that decision, because it
 * is the side that knows whether the failure was a dead network or a rejected
 * file, and a retry loop in here would be a retry loop competing with the live
 * broadcast for the same upstream.
 */

/**
 * Longest `stop()` will wait for segments already on the wire.
 *
 * See the note in `runStop`. This is the ceiling on how long the host's End
 * button can block, not a target — a healthy drain is a second or two.
 */
const UPLOAD_DRAIN_TIMEOUT_MS = 90_000;

export type RecorderState = "idle" | "recording" | "uploading" | "error";

/**
 * Container and codecs, in preference order.
 *
 * VP9 first because it is materially smaller than VP8 at the same quality, and
 * slides — which is most of what a webinar shows — are exactly the content VP9
 * is best at. `video/webm` bare is the fallback for a browser that supports the
 * container but reports nothing about codecs, and `video/mp4` is Safari, which
 * only learned `MediaRecorder` at all in 14.1 and still answers no to every
 * WebM string.
 */
const MIME_CANDIDATES = [
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
  "video/mp4",
] as const;

/** 720p, fixed. See the note on `composeFrame` for why this is not the source size. */
const CANVAS_WIDTH = 1280;
const CANVAS_HEIGHT = 720;

/**
 * How often the recorder hands us a chunk within a segment.
 *
 * Not a segment boundary — these chunks are meaningless on their own and are
 * simply concatenated at the end of the segment. The reason to ask for them at
 * all is that a `MediaRecorder` given no timeslice buffers the entire segment
 * inside the encoder, where we cannot see it and cannot bound it; asking once a
 * second moves that buffer into an array we own.
 */
const CHUNK_MS = 1000;

/**
 * How long the draw loop may go without producing a frame before we conclude
 * the browser has stopped calling us and switch to a timer.
 *
 * Three frame intervals rather than one, because a single late frame is
 * ordinary — a garbage collection, a layout, a screen-share negotiation — and
 * flapping between the two schedulers would cost more frames than it saves.
 */
const STALL_MS = (1000 / RECORDING_FPS) * 3;

/** Backdrop behind the letterboxed picture. Matches `bg-ink-900`'s weight. */
const BACKDROP = "#0b0b0d";
const CARD_FILL = "#17171a";
const CARD_TEXT = "#f4f4f5";
const INSET_BORDER = "#3f3f46";
const TAG_FILL = "rgba(0, 0, 0, 0.6)";
const FONT_STACK = "ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif";

/**
 * Someone other than the recording host, to be composed into a 1:1's recording.
 *
 * Streams are present only while that slot is actually carrying media — the
 * live-session engine drops a muted slot rather than handing over black frames
 * — so a null camera is a camera that is off, not one still loading.
 */
export type RecorderRemote = {
  id: string;
  name: string;
  camera: MediaStream | null;
  screen: MediaStream | null;
  audio: MediaStream | null;
  /** False draws "Waiting for <name>" rather than "Camera off". */
  connected: boolean;
};

export function useRecorder({
  eventId,
  enabled,
  cameraStream,
  screenStream,
  micStream,
  cameraOn,
  micOn,
  onSegment,
  remotes,
  localName,
}: {
  eventId: string;
  /** Gates the whole machine: host, joined, and recording turned on. */
  enabled: boolean;
  cameraStream: MediaStream | null;
  screenStream: MediaStream | null;
  /** Usually the same object as `cameraStream` — `getUserMedia` returns both on one stream. */
  micStream: MediaStream | null;
  /**
   * Whether the host's camera is *sending*, not whether a track exists. See
   * the note in `composeFrame`: a muted track is not an absent one.
   */
  cameraOn: boolean;
  micOn: boolean;
  onSegment: (blob: Blob, index: number, durationSeconds: number) => Promise<void>;
  /**
   * The other people in a 1:1, to composite in and mix with the local mic.
   * Leave undefined for a webinar, which records the host alone — see the
   * header. An empty array still means "a call": the other person just has
   * not arrived yet.
   */
  remotes?: RecorderRemote[];
  /** The local person's name, for their tile in a 1:1 recording. */
  localName?: string;
}): {
  state: RecorderState;
  /** Segments successfully handed to `onSegment`. */
  uploaded: number;
  /** Seconds recorded so far, across all segments. */
  seconds: number;
  error: string | null;
  start: () => void;
  /**
   * Flush the current segment and await its upload. Awaitable because the
   * host's End button awaits it before tearing the tracks down — stopping the
   * camera first would cut the last segment mid-frame.
   */
  stop: () => Promise<void>;
} {
  const [state, setState] = useState<RecorderState>("idle");
  const [uploaded, setUploaded] = useState(0);
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // Everything the machine needs lives in refs, for the same reason
  // `useLocalMedia` holds its stream in one: teardown has to be able to run
  // from an unmount cleanup, where no further render will happen and state
  // from the last one may already be stale.
  const mountedRef = useRef(true);
  const runningRef = useRef(false);
  /** Set when the machine cannot continue at all — distinct from a failed upload. */
  const fatalRef = useRef(false);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
  const camElRef = useRef<HTMLVideoElement | null>(null);
  const screenElRef = useRef<HTMLVideoElement | null>(null);
  const captureRef = useRef<MediaStream | null>(null);
  const mixRef = useRef<MediaStream | null>(null);
  const mimeRef = useRef<string | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const rotateRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Resolves once the CURRENT segment has stopped and its upload has settled. */
  const doneRef = useRef<Promise<void> | null>(null);
  /**
   * Every segment upload still on the wire — not just the newest one.
   *
   * `doneRef` only ever points at the segment that stopped most recently, and
   * by design a new segment is begun BEFORE the previous one's upload is
   * awaited, so on a slow uplink two or three files are in flight at once.
   * `stop()` used to await `doneRef` alone, and the consequence was silent
   * data loss: the host clicks End at 12:00 while segment 4 (minutes 8-10) is
   * still climbing hotel wifi, `stop()` resolves on segment 5 only, the caller
   * tears the room down, the component unmounts, the page navigates, and
   * segment 4's request dies in flight. The recording is missing a segment
   * of the talk and nothing — no error, no counter, no state — ever says so.
   * So every upload registers here for the length of its flight and `runStop`
   * waits for all of them. A Set rather than an array because entries are
   * removed as they land; an hour-long webinar must not finish holding thirty
   * settled promises it will never look at again.
   */
  const inFlightRef = useRef<Set<Promise<void>>>(new Set());
  const nextIndexRef = useRef(0);
  const pendingUploadsRef = useRef(0);
  const failuresRef = useRef(0);

  const rafRef = useRef<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const watchdogRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const clockRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastDrawRef = useRef(0);
  const segmentStartRef = useRef(0);
  const recordedRef = useRef(0);

  /** One in-flight stop, shared by every caller — see `stop`. */
  const stopPromiseRef = useRef<Promise<void> | null>(null);
  /** True from the first line of `runStop` until its teardown has run. */
  const stoppingRef = useRef(false);

  /**
   * "solo" records the local host alone (a webinar); "call" composites every
   * participant and mixes their audio. Fixed at `start()` from whether
   * `remotes` was passed, so a run never changes shape halfway through a file.
   */
  const modeRef = useRef<"solo" | "call">("solo");
  const remotesRef = useRef(remotes);
  remotesRef.current = remotes;
  const localNameRef = useRef(localName);
  localNameRef.current = localName;
  /** Off-screen elements for each remote's camera and screen, by participant id. */
  const remoteElsRef = useRef(
    new Map<string, { cam: HTMLVideoElement; screen: HTMLVideoElement }>(),
  );
  /** The call-mode audio mix: one context, one destination, one source per voice. */
  const audioCtxRef = useRef<AudioContext | null>(null);
  const audioDestRef = useRef<MediaStreamAudioDestinationNode | null>(null);
  const audioNodesRef = useRef(
    new Map<string, { trackId: string; node: MediaStreamAudioSourceNode }>(),
  );

  /**
   * `teardown`, reachable from `fail`.
   *
   * `fail` is declared above everything it needs to shut down, so it used to
   * set the error and leave the machine running: on a mid-webinar fatal (the
   * `MediaRecorder` constructor refusing on a segment rotation, which is the
   * only fatal that can happen after `start` has already built everything) the
   * draw loop, the stall watchdog and the seconds clock all kept ticking for
   * the rest of the hour. That is a rAF-per-frame canvas composite burning CPU
   * on the one machine that is simultaneously encoding and uploading live
   * video to the whole room, in service of a recorder that no longer exists.
   * Same ref trick as `beginSegmentRef`, for the same reason.
   */
  const teardownRef = useRef<() => void>(() => {});

  // Props the draw loop and the segment callbacks read. Held in refs rather
  // than closed over, because the loop is started once and must not be torn
  // down and rebuilt every time the host toggles their camera — the same
  // discipline `useLiveSession` applies to its own lifecycle.
  const onSegmentRef = useRef(onSegment);
  onSegmentRef.current = onSegment;
  const cameraOnRef = useRef(cameraOn);
  cameraOnRef.current = cameraOn;
  const micOnRef = useRef(micOn);
  micOnRef.current = micOn;

  const syncState = useCallback(() => {
    if (!mountedRef.current) return;
    if (fatalRef.current) {
      setState("error");
      return;
    }
    if (runningRef.current) {
      setState("recording");
      return;
    }
    // Stopped, but the last segment is still on the wire. The host's End
    // button leans on this: it is the difference between "you can close the
    // laptop" and "don't".
    setState(pendingUploadsRef.current > 0 ? "uploading" : "idle");
  }, []);

  const fail = useCallback(
    (message: string) => {
      fatalRef.current = true;
      runningRef.current = false;
      // Release the loops and the canvas capture as well as flipping the flag.
      // A fatal raised after `start` succeeded (a recorder that refuses to
      // construct on a later rotation) otherwise left the draw loop, the
      // watchdog and the clock running for the remainder of the webinar,
      // composing frames at RECORDING_FPS into a canvas nothing was reading.
      // `teardown` is idempotent and never touches a caller's tracks, so this
      // is also safe on the fatals raised before anything was allocated.
      teardownRef.current();
      if (mountedRef.current) setError(message);
      syncState();
    },
    [syncState],
  );

  // --- the composed picture -------------------------------------------------

  /**
   * Draw one frame.
   *
   * Reads the source `<video>` elements rather than the `MediaStream`s: a
   * stream has no pixels, and `drawImage` needs an element that has decoded
   * something. `readyState`/`videoWidth` are checked every frame because a
   * screen share that was picked a moment ago is attached before it has a
   * single frame to give, and drawing it then paints nothing over nothing.
   */
  /**
   * One frame of a 1:1: everyone, labelled.
   *
   * Side by side in equal columns — nobody in a 1:1 is the audience — unless
   * someone is presenting, in which case the shared screen takes the frame
   * (it is what both of them are looking at and talking about) and each face
   * drops to an inset. The local person's camera is read through `cameraOn`
   * for the same black-frames reason as the solo path below; a remote's is
   * simply absent when off, because the engine only hands over live slots.
   */
  const composeCallFrame = useCallback((ctx: CanvasRenderingContext2D) => {
    type Tile = {
      name: string;
      cam: HTMLVideoElement | null;
      screen: HTMLVideoElement | null;
      placeholder: string;
    };
    const tiles: Tile[] = [
      {
        name: localNameRef.current || "Host",
        cam:
          cameraOnRef.current && ready(camElRef.current) ? camElRef.current : null,
        screen: ready(screenElRef.current) ? screenElRef.current : null,
        placeholder: cardMessage(cameraOnRef.current, camElRef.current),
      },
    ];
    for (const r of remotesRef.current ?? []) {
      const els = remoteElsRef.current.get(r.id) ?? null;
      tiles.push({
        name: r.name,
        cam: els && ready(els.cam) ? els.cam : null,
        screen: els && ready(els.screen) ? els.screen : null,
        placeholder: !r.connected
          ? `Waiting for ${r.name}`
          : r.camera
            ? "Camera starting"
            : "Camera off",
      });
    }

    const full = { x: 0, y: 0, w: CANVAS_WIDTH, h: CANVAS_HEIGHT };
    const presenter = tiles.find((t) => t.screen);
    if (presenter?.screen) {
      drawContain(ctx, presenter.screen, full);
      const insets = callInsetBoxes(tiles.length, CANVAS_WIDTH, CANVAS_HEIGHT);
      tiles.forEach((t, i) => drawPerson(ctx, t.cam, insets[i], t.name, t.placeholder, true));
      return;
    }
    const boxes = callTileBoxes(tiles.length, CANVAS_WIDTH, CANVAS_HEIGHT);
    tiles.forEach((t, i) => drawPerson(ctx, t.cam, boxes[i], t.name, t.placeholder, false));
  }, []);

  const composeFrame = useCallback(() => {
    const ctx = ctxRef.current;
    if (!ctx) return;
    lastDrawRef.current = now();

    ctx.fillStyle = BACKDROP;
    ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

    if (modeRef.current === "call") {
      composeCallFrame(ctx);
      return;
    }

    const screenEl = ready(screenElRef.current) ? screenElRef.current : null;
    // `cameraOn` is consulted, not `track.enabled`, and this is the whole
    // reason it is a prop. `useLocalMedia.toggleCamera` disables the track
    // and deliberately does NOT stop it (stopping would re-prompt on Safari
    // when it came back), and a disabled video track keeps producing frames —
    // black ones. Reading the track would therefore record five minutes of
    // black rectangles and call it a camera. The wire has the same problem and
    // solves it the same way, by being told rather than guessing.
    const camEl = cameraOnRef.current && ready(camElRef.current) ? camElRef.current : null;

    const main = screenEl ?? camEl;
    if (!main) {
      // Nothing decodable right now. Which sentence depends on why, and the
      // screen-share case has to be asked about separately: the picker has
      // been answered (the element has a stream) but the first frame has not
      // arrived, which is a second or two during which "Camera off" would be
      // an actively wrong thing to record.
      const sharing = !!screenElRef.current?.srcObject;
      drawCard(
        ctx,
        sharing ? "Screen share starting" : cardMessage(cameraOnRef.current, camElRef.current),
      );
      return;
    }

    // Contain-fit, never cover. A 4:3 webcam stretched to 16:9 is the kind of
    // wrongness nobody reports and everybody notices, and cropping to fill
    // would cut the top off a presenter sitting normally in frame.
    drawContain(ctx, main, { x: 0, y: 0, w: CANVAS_WIDTH, h: CANVAS_HEIGHT });

    // While presenting, the camera drops to a corner — the same arrangement
    // the audience is seeing in broadcast-room, so the recording matches the
    // memory of the talk rather than being a different edit of it.
    if (screenEl && camEl) {
      const inset = { x: CANVAS_WIDTH - 344, y: CANVAS_HEIGHT - 218, w: 320, h: 180 };
      ctx.fillStyle = BACKDROP;
      ctx.fillRect(inset.x, inset.y, inset.w, inset.h);
      drawContain(ctx, camEl, inset);
      ctx.strokeStyle = INSET_BORDER;
      ctx.lineWidth = 2;
      ctx.strokeRect(inset.x + 1, inset.y + 1, inset.w - 2, inset.h - 2);
    }
  }, [composeCallFrame]);

  // --- the draw loop, and the reason it is not just rAF --------------------

  const stopLoop = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  /**
   * Draw on a timer instead of on frames.
   *
   * This is the fallback, and it exists because of the single least obvious
   * failure in this file: **`requestAnimationFrame` is throttled to a crawl,
   * and in most browsers stopped outright, in a backgrounded tab.** The host
   * alt-tabs to their notes — an entirely normal thing to do thirty seconds
   * into a talk — the canvas stops being redrawn, `captureStream` therefore
   * stops producing frames, and the recording freezes on whatever was on
   * screen when they switched, for as long as they stay away. Nothing warns
   * them. The webinar itself is completely unaffected, because the live wire
   * carries the camera track directly and never touches the canvas, so the
   * only symptom appears hours later in a file nobody watches until they do.
   *
   * `setInterval` is throttled too — clamped to about once a second in a
   * hidden tab — but clamped is not stopped. The recording goes choppy for as
   * long as the host is away and then recovers, which is an enormously better
   * outcome than a frozen hour, and the audio (which is not drawn and not
   * throttled) stays continuous throughout either way.
   */
  const startTimerLoop = useCallback(() => {
    stopLoop();
    timerRef.current = setInterval(composeFrame, 1000 / RECORDING_FPS);
  }, [composeFrame, stopLoop]);

  const startRafLoop = useCallback(() => {
    stopLoop();
    const frameMs = 1000 / RECORDING_FPS;
    const tick = () => {
      rafRef.current = requestAnimationFrame(tick);
      // rAF runs at the display's rate, which is 60Hz or 120Hz; recording at
      // RECORDING_FPS means skipping most of those callbacks rather than
      // encoding frames nobody asked for. The half-millisecond slack keeps a
      // 24fps target from landing just under the threshold every other frame
      // on a 60Hz panel and silently recording at 20.
      if (now() - lastDrawRef.current + 0.5 < frameMs) return;
      composeFrame();
    };
    rafRef.current = requestAnimationFrame(tick);
  }, [composeFrame, stopLoop]);

  /** Pick a scheduler for the tab's current state, and keep watching it. */
  const startLoop = useCallback(() => {
    if (typeof document !== "undefined" && document.hidden) startTimerLoop();
    else startRafLoop();

    // The watchdog catches what `document.hidden` does not. A window that is
    // fully occluded by another, a macOS laptop on battery in Low Power Mode,
    // and a Safari tab in a background window all throttle rAF while still
    // reporting the tab as visible — so the flag alone would leave exactly the
    // hosts on battery, presenting from behind a slide deck, recording at two
    // frames a second.
    if (watchdogRef.current === null) {
      watchdogRef.current = setInterval(() => {
        if (!runningRef.current) return;
        if (timerRef.current !== null) return;
        if (now() - lastDrawRef.current > STALL_MS) startTimerLoop();
      }, 1000);
    }
  }, [startRafLoop, startTimerLoop]);

  // --- segments -------------------------------------------------------------

  // `beginSegment` restarts itself at the end of each segment, so it reaches
  // itself through a ref. Same shape as `disconnectFromRef` in
  // use-live-session: a self-referential callback cannot be written as a plain
  // `useCallback` without either a stale closure or a dependency cycle.
  const beginSegmentRef = useRef<() => void>(() => {});

  const beginSegment = useCallback(() => {
    const mix = mixRef.current;
    const mime = mimeRef.current;
    if (!mix || !mime) return;

    let rec: MediaRecorder;
    try {
      rec = new MediaRecorder(mix, {
        mimeType: mime,
        videoBitsPerSecond: RECORDING_VIDEO_BITRATE,
        audioBitsPerSecond: RECORDING_AUDIO_BITRATE,
      });
    } catch {
      // `isTypeSupported` said yes and the constructor said no, which happens
      // on builds where the container is supported but the bitrate options are
      // not. Nothing further to try that would not be a guess.
      fail(`This browser wouldn't start a recorder. The ${subject(modeRef.current)} is unaffected — it just won't be recorded.`);
      return;
    }

    const chunks: Blob[] = [];
    const startedAt = now();
    segmentStartRef.current = startedAt;
    recorderRef.current = rec;

    let settle: () => void = () => {};
    doneRef.current = new Promise<void>((resolve) => {
      settle = resolve;
    });

    rec.ondataavailable = (ev: BlobEvent) => {
      if (ev.data && ev.data.size > 0) chunks.push(ev.data);
    };

    rec.onerror = () => {
      // The recorder is done either way — `onstop` follows — so this only
      // needs to say so. Left non-fatal on purpose: the restart below gets a
      // fresh encoder, and one bad segment is not a reason to stop recording
      // the rest of the hour.
      failuresRef.current += 1;
      if (mountedRef.current) {
        setError("A recording segment failed to encode. Recording continued from the next one.");
      }
    };

    rec.onstop = () => {
      if (rotateRef.current !== null) {
        clearTimeout(rotateRef.current);
        rotateRef.current = null;
      }
      const duration = Math.max(0, (now() - startedAt) / 1000);
      recordedRef.current += duration;
      const index = nextIndexRef.current++;
      const blob = new Blob(chunks, { type: mime });
      chunks.length = 0;
      recorderRef.current = null;

      // Restart BEFORE the upload is awaited, not after. The seam between two
      // segments is meant to be the recorder's restart — tens of milliseconds
      // — and awaiting a 19 MB upload first would make it however long the
      // host's upstream takes, which is to say the recording would skip a
      // minute of the talk every time the network had a bad few minutes.
      if (runningRef.current) beginSegmentRef.current();

      if (blob.size === 0) {
        settle();
        syncState();
        return;
      }

      pendingUploadsRef.current += 1;
      syncState();
      // Published to `inFlightRef` before the first await, so a `stop()` that
      // lands one tick later can already see this upload and wait for it. The
      // promise is created here rather than being the async function's own,
      // because the `finally` below has to be able to name the entry it is
      // removing and the IIFE's promise does not exist until after its body
      // has started running.
      let landed: () => void = () => {};
      const flight = new Promise<void>((resolve) => {
        landed = resolve;
      });
      inFlightRef.current.add(flight);
      void (async () => {
        try {
          await onSegmentRef.current(blob, index, duration);
          if (mountedRef.current) setUploaded((n) => n + 1);
        } catch (err: any) {
          // A failed upload must never stop the recording. The segment is
          // gone — we do not hold it, because holding failures is how the
          // memory bound this whole design exists to keep gets lost — but the
          // next one is already being written, and losing two minutes of an
          // hour is a far better outcome than losing the other fifty-eight.
          failuresRef.current += 1;
          if (mountedRef.current) setError(uploadErrorText(err, failuresRef.current));
        } finally {
          pendingUploadsRef.current -= 1;
          // Off the in-flight list whether it uploaded or threw: a `stop()`
          // waiting on the set is waiting for flights to END, not to succeed,
          // and an entry left behind would make every later stop wait on a
          // promise that had already resolved.
          inFlightRef.current.delete(flight);
          landed();
          settle();
          syncState();
        }
      })();
    };

    try {
      rec.start(CHUNK_MS);
    } catch {
      fail(`This browser wouldn't start a recorder. The ${subject(modeRef.current)} is unaffected — it just won't be recorded.`);
      settle();
      return;
    }

    rotateRef.current = setTimeout(() => {
      if (!runningRef.current) return;
      const current = recorderRef.current;
      if (current && current.state !== "inactive") current.stop();
    }, RECORDING_SEGMENT_SECONDS * 1000);
  }, [fail, syncState]);
  beginSegmentRef.current = beginSegment;

  // --- sources --------------------------------------------------------------

  /**
   * Point the off-screen `<video>` elements at the current streams.
   *
   * These elements are created in JS and never mounted. They are not hidden
   * React nodes — they are not React nodes at all — because a `<video>` in the
   * tree is a layout participant, an accessibility node, and something a
   * stylesheet can reach; an element that exists only to be read by
   * `drawImage` should be reachable by nothing.
   */
  const syncSources = useCallback(() => {
    attach(camElRef.current, cameraStream);
    attach(screenElRef.current, screenStream);

    // The other people in a 1:1 — only while a call-mode run is live, so a
    // webinar (or a call not recording yet) never creates a single element.
    if (modeRef.current !== "call" || !runningRef.current) return;
    const els = remoteElsRef.current;
    const present = new Set<string>();
    for (const r of remotes ?? []) {
      present.add(r.id);
      let e = els.get(r.id);
      if (!e) {
        e = { cam: sourceVideo(), screen: sourceVideo() };
        els.set(r.id, e);
      }
      attach(e.cam, r.camera);
      attach(e.screen, r.screen);
    }
    for (const [id, e] of els) {
      if (present.has(id)) continue;
      attach(e.cam, null);
      attach(e.screen, null);
      els.delete(id);
    }
  }, [cameraStream, screenStream, remotes]);

  /**
   * Keep the call-mode mix wired to exactly the voices in the room.
   *
   * One `MediaStreamAudioSourceNode` per voice, keyed by who it is and
   * remembering which TRACK it was built on. A source node binds to the track
   * a stream held when the node was made and never follows a replacement, and
   * the engine reuses one stream object per slot across replacements — so a
   * node whose track id no longer matches is rebuilt, and one for someone who
   * went silent (muted, or gone) is disconnected. The destination, and
   * therefore the recorded track, is never touched, so none of this costs a
   * segment seam the way a solo-mode device change does.
   *
   * Remote audio is taken from the very stream the room's hidden `<audio>`
   * element is playing (broadcast-room's AudioSink). That matters in Chrome,
   * which does not pull remote WebRTC audio through Web Audio at all unless
   * the stream is also attached to a media element — the recording would be
   * one side of a silent conversation.
   */
  const syncCallAudio = useCallback(() => {
    const actx = audioCtxRef.current;
    const dest = audioDestRef.current;
    if (!actx || !dest || !runningRef.current) return;

    const wanted = new Map<string, { stream: MediaStream; trackId: string }>();
    const mic = micStream?.getAudioTracks()[0];
    if (micStream && mic) wanted.set("local", { stream: micStream, trackId: mic.id });
    for (const r of remotes ?? []) {
      const t = r.audio?.getAudioTracks()[0];
      if (r.audio && t) wanted.set(`remote:${r.id}`, { stream: r.audio, trackId: t.id });
    }

    const nodes = audioNodesRef.current;
    for (const [key, entry] of nodes) {
      if (wanted.get(key)?.trackId === entry.trackId) continue;
      try {
        entry.node.disconnect();
      } catch {
        /* already disconnected */
      }
      nodes.delete(key);
    }
    for (const [key, want] of wanted) {
      if (nodes.has(key)) continue;
      try {
        const node = actx.createMediaStreamSource(want.stream);
        node.connect(dest);
        nodes.set(key, { trackId: want.trackId, node });
      } catch {
        // The track ended between the read and here. Its replacement arrives
        // with the next render, and this runs again.
      }
    }
  }, [micStream, remotes]);

  /**
   * Keep the recorded audio track in step with the host's microphone.
   *
   * Note what is NOT done here: a muted mic is not removed. `toggleMic`
   * disables the track without stopping it, so a muted host records silence —
   * which is exactly right, because silence is what the audience heard. The
   * camera is the opposite case (a disabled video track records black, which
   * is *not* what the audience saw, hence the card in `composeFrame`), and
   * this asymmetry is the whole reason the two are handled in different
   * places.
   *
   * A genuine device change is different: the track object is replaced, and a
   * running `MediaRecorder` will not notice a track added to a stream it is
   * already recording. So the mix is updated and the segment is rotated, which
   * costs one seam and picks the new microphone up on the next file.
   */
  const syncAudio = useCallback(() => {
    if (modeRef.current === "call") {
      syncCallAudio();
      return;
    }
    const mix = mixRef.current;
    if (!mix) return;
    const wanted = micStream?.getAudioTracks()[0] ?? null;
    const current = mix.getAudioTracks()[0] ?? null;
    if (wanted === current) return;
    if (current) mix.removeTrack(current);
    if (wanted) mix.addTrack(wanted);
    const rec = recorderRef.current;
    if (runningRef.current && rec && rec.state !== "inactive") rec.stop();
  }, [micStream, syncCallAudio]);

  useEffect(() => {
    syncSources();
  }, [syncSources]);

  useEffect(() => {
    syncAudio();
  }, [syncAudio]);

  // --- lifecycle ------------------------------------------------------------

  /** Release everything this hook created. Never touches a caller's tracks. */
  const teardown = useCallback(() => {
    runningRef.current = false;
    stopLoop();
    if (watchdogRef.current !== null) {
      clearInterval(watchdogRef.current);
      watchdogRef.current = null;
    }
    if (clockRef.current !== null) {
      clearInterval(clockRef.current);
      clockRef.current = null;
    }
    if (rotateRef.current !== null) {
      clearTimeout(rotateRef.current);
      rotateRef.current = null;
    }
    const rec = recorderRef.current;
    if (rec && rec.state !== "inactive") {
      // Still worth stopping rather than dropping: `onstop` will fire, and its
      // upload is a last chance to save the segment the host was in the middle
      // of when they navigated away.
      try {
        rec.stop();
      } catch {
        /* already gone */
      }
    }
    // The canvas capture track is ours — `getUserMedia` and `getDisplayMedia`
    // tracks are not, and stopping one of those here would turn the host's
    // camera off mid-broadcast.
    captureRef.current?.getTracks().forEach((t) => t.stop());
    captureRef.current = null;
    mixRef.current = null;
    attach(camElRef.current, null);
    attach(screenElRef.current, null);
    camElRef.current = null;
    screenElRef.current = null;
    canvasRef.current = null;
    ctxRef.current = null;

    // Call mode. The remote elements are ours; the remote STREAMS are the
    // room's, still playing in its tiles, and are only detached, never stopped.
    for (const e of remoteElsRef.current.values()) {
      attach(e.cam, null);
      attach(e.screen, null);
    }
    remoteElsRef.current.clear();
    for (const { node } of audioNodesRef.current.values()) {
      try {
        node.disconnect();
      } catch {
        /* already disconnected */
      }
    }
    audioNodesRef.current.clear();
    audioDestRef.current = null;
    // Closing is what releases the audio graph; left open, Chrome keeps the
    // tab's "using your microphone" indicator lit after the call has ended.
    const actx = audioCtxRef.current;
    audioCtxRef.current = null;
    if (actx) void actx.close().catch(() => {});
  }, [stopLoop]);
  teardownRef.current = teardown;

  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const eventIdRef = useRef(eventId);
  eventIdRef.current = eventId;
  /**
   * The event the CURRENT (or most recent) run started under.
   *
   * `index` is the only identifier `onSegment` gets, and the server upserts on
   * `(event_id, sort_order)` — so restarting the recorder inside one webinar
   * and numbering from zero again does not append, it OVERWRITES. A host who
   * stopped recording to take a phone call and started again twenty minutes
   * later used to come back to a recording whose first segments had been
   * silently replaced by the second run's. The counter therefore survives a
   * stop/start and only goes back to zero when the webinar being recorded is
   * genuinely a different one, which this ref is what detects.
   */
  const runEventIdRef = useRef<string | null>(null);

  /** `start`, reachable from a deferred restart inside `start` itself. */
  const startRef = useRef<() => void>(() => {});

  const start = useCallback(() => {
    // `fatalRef` is sticky on purpose. Everything that sets it is a statement
    // about the browser — no MediaRecorder, no codec, no canvas capture — and
    // none of those become true on a second press. Re-running the probes would
    // only replace the host's error message with the same error message.
    if (runningRef.current || fatalRef.current) return;
    if (!enabledRef.current) return;
    if (typeof window === "undefined") return;

    // A stop still draining — the gate closed and reopened inside the ninety
    // seconds `runStop` may spend waiting on uploads. Starting now would build
    // a new canvas and mix that the pending teardown then rips out from under
    // the new run, so wait for it and start behind it (if still wanted).
    if (stoppingRef.current) {
      void stopPromiseRef.current?.then(() => {
        if (enabledRef.current) startRef.current();
      });
      return;
    }

    // Fixed for the whole run. See the header: `remotes` passed at all means a
    // 1:1, composited and mixed; absent means a webinar, the host alone.
    modeRef.current = remotesRef.current !== undefined ? "call" : "solo";
    const what = subject(modeRef.current);

    // Feature detection before anything is allocated, and never a throw: a
    // browser that cannot record is a browser where the webinar must still
    // run. The host is told, once, in a sentence that says so.
    if (typeof window.MediaRecorder === "undefined") {
      fail(`This browser can't record. Try Chrome or Edge — the ${what} itself works either way.`);
      return;
    }
    const mime = MIME_CANDIDATES.find((c) => {
      try {
        return MediaRecorder.isTypeSupported(c);
      } catch {
        return false;
      }
    });
    if (!mime) {
      fail(`This browser can't record in any format we can store. The ${what} itself is unaffected.`);
      return;
    }

    const canvas = document.createElement("canvas");
    canvas.width = CANVAS_WIDTH;
    canvas.height = CANVAS_HEIGHT;
    // Same shape as the `getDisplayMedia` probe in broadcast-room's
    // useScreenShare: read the method off a narrowed type rather than assuming
    // the DOM lib's optimism about what every browser ships.
    const capture = (canvas as { captureStream?: (fps?: number) => MediaStream }).captureStream;
    if (typeof capture !== "function") {
      fail(`This browser can't capture a canvas, so it can't record. The ${what} itself is unaffected.`);
      return;
    }
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) {
      fail("This browser wouldn't give us a drawing surface, so it can't record.");
      return;
    }

    let captured: MediaStream;
    try {
      captured = capture.call(canvas, RECORDING_FPS);
    } catch {
      fail(`This browser can't capture a canvas, so it can't record. The ${what} itself is unaffected.`);
      return;
    }

    canvasRef.current = canvas;
    ctxRef.current = ctx;
    captureRef.current = captured;
    mimeRef.current = mime;
    camElRef.current = sourceVideo();
    screenElRef.current = sourceVideo();

    // One stream for the recorder: the canvas's single, permanently continuous
    // video track plus the live microphone track. The mic is added by reference, not
    // cloned — a clone is a second consumer of the same device and shows up as
    // extra CPU on a machine that is already encoding for the whole room.
    const mix = new MediaStream();
    captured.getVideoTracks().forEach((t) => mix.addTrack(t));

    // A 1:1 records a conversation, so its one audio track is a MIX: every
    // voice goes into this destination (syncCallAudio) and the destination's
    // track goes into the file. It exists from the first frame, carrying
    // silence until someone speaks, so the recorder never has to be told that
    // an audio track appeared — the thing solo mode rotates a segment for.
    if (modeRef.current === "call") {
      const AC =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      try {
        if (!AC) throw new Error("no AudioContext");
        const actx = new AC();
        const dest = actx.createMediaStreamDestination();
        audioCtxRef.current = actx;
        audioDestRef.current = dest;
        dest.stream.getAudioTracks().forEach((t) => mix.addTrack(t));
        // Created after the Join click, so autoplay policy lets it run; resume
        // anyway, because a context that starts suspended records silence.
        void actx.resume?.().catch(() => {});
      } catch {
        fail(`This browser can't mix the call's audio, so it can't record. The ${what} itself is unaffected.`);
        return;
      }
    }
    mixRef.current = mix;

    runningRef.current = true;
    stopPromiseRef.current = null;
    recordedRef.current = 0;
    // Deliberately NOT unconditional. Resetting the segment index on every
    // press is what made a second run inside one webinar overwrite the first
    // run's files; the reset belongs to a change of event, and it happens here
    // rather than in the effect that watches `eventId` because the outgoing
    // webinar's final segment may still be between `onstop` and its upload,
    // and it takes its number from this counter when it gets there.
    if (runEventIdRef.current !== eventIdRef.current) {
      nextIndexRef.current = 0;
      runEventIdRef.current = eventIdRef.current;
    }
    failuresRef.current = 0;
    lastDrawRef.current = now();
    if (mountedRef.current) {
      setError(null);
      setUploaded(0);
      setSeconds(0);
    }

    syncSources();
    syncAudio();
    // One frame before the recorder opens, so the first segment starts on the
    // composed picture rather than on an undrawn, transparent canvas — which
    // some encoders render as a flash of white in the first frames.
    composeFrame();
    startLoop();

    if (clockRef.current === null) {
      clockRef.current = setInterval(() => {
        if (!mountedRef.current) return;
        const live = runningRef.current ? (now() - segmentStartRef.current) / 1000 : 0;
        setSeconds(Math.floor(recordedRef.current + live));
      }, 1000);
    }

    beginSegmentRef.current();
    syncState();
  }, [composeFrame, fail, startLoop, syncAudio, syncSources, syncState]);
  startRef.current = start;

  const runStop = useCallback(async () => {
    stoppingRef.current = true;
    // Ordered deliberately: `runningRef` goes false FIRST, so the `onstop`
    // handler below does not helpfully start a new segment behind us.
    runningRef.current = false;
    if (rotateRef.current !== null) {
      clearTimeout(rotateRef.current);
      rotateRef.current = null;
    }
    stopLoop();
    syncState();

    const rec = recorderRef.current;
    let done = doneRef.current;
    // Stopped whenever it is live, without asking whether WE were the ones who
    // thought it was running. `fail` clears `runningRef` while a recorder is
    // still open, and the old `wasRunning` guard meant that in exactly that
    // state nobody stopped it, nobody fired `onstop`, and `done` — which only
    // `onstop` resolves — stayed pending forever. `stop()` never returned, so
    // the End button's `await recorder.stop()` never returned either and the
    // host was stuck in a room with a dead recorder.
    if (rec && rec.state !== "inactive") {
      try {
        rec.stop();
      } catch {
        // Refused to stop, so its `onstop` is never coming and `done` is a
        // promise with nothing left to resolve it. Drop it rather than await
        // it, for the same reason: a hang here traps the host.
        done = null;
      }
    }
    // ONE deadline for the whole drain, started here and shared by both
    // waits below. Its bound is the point: `stop()` is awaited by the host's
    // End button (and a 1:1's Leave) before it stops the tracks and tells the
    // server the call or webinar ended, so an unbounded wait here is a host
    // trapped in a room they have already finished — on dead hotel wifi, a
    // stalled PUT holds that button until the OS gives up on the socket,
    // which can be many minutes, with nothing on screen but "Saving the
    // recording…" and the other person's room still open.
    //
    // Ninety seconds is well past a healthy upload of the two or three files
    // that can realistically be in flight, and short enough that a host who
    // has genuinely lost the network gets out. Losing the tail of a recording
    // is a bad outcome; being unable to end a call is a worse one, and the
    // abandoned uploads may well still land on their own afterwards — the
    // caller's next step is a client-side navigation, which does not cancel
    // them.
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => {
      deadlineTimer = setTimeout(resolve, UPLOAD_DRAIN_TIMEOUT_MS);
    });

    // `done` resolves inside `onstop`, after the final `dataavailable` has been
    // collected AND after `onSegment` has settled. Awaiting the recorder's
    // `onstop` alone would resolve while the last segment was still on the
    // wire, and the caller would tear the tracks down under it. Raced against
    // the deadline like everything else: `onSegment` is a server action and a
    // storage PUT, neither of which has a timeout of its own, and this await
    // used to be the one wait in here with no bound at all.
    await Promise.race([done ?? Promise.resolve(), deadline]);
    // And then everything queued BEHIND the final segment. By the time `done`
    // resolves the last file has landed, but earlier segments can still be
    // uploading — that is the whole point of starting the next segment before
    // awaiting the previous one's upload. Settled, not `all`: a segment that
    // failed to upload has already reported itself through `setError`, and
    // rejecting here would turn one lost file into a `stop()` that throws into
    // the End button and skips stamping the webinar as ended. Snapshotted only
    // now, not before `rec.stop()`: `onstop` fires asynchronously, and a
    // snapshot taken up front would miss the final segment's own flight.
    const flights = Array.from(inFlightRef.current);
    if (flights.length > 0) {
      await Promise.race([Promise.allSettled(flights), deadline]);
    }
    clearTimeout(deadlineTimer);
    teardown();
    stoppingRef.current = false;
    syncState();
  }, [stopLoop, syncState, teardown]);

  /**
   * Stop, idempotently.
   *
   * Every caller gets the same promise. The host's End button is the caller,
   * and a double-click on it must not stop a recorder that is already stopping
   * and resolve early on a segment that has not finished uploading.
   */
  const stop = useCallback((): Promise<void> => {
    if (!stopPromiseRef.current) stopPromiseRef.current = runStop();
    return stopPromiseRef.current;
  }, [runStop]);

  // A backgrounded tab is handled the moment it happens rather than waiting up
  // to a second for the watchdog — the first second is the one where the host
  // is most likely to still be saying something.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const onVisibility = () => {
      if (!runningRef.current) return;
      if (document.hidden) startTimerLoop();
      else startRafLoop();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [startRafLoop, startTimerLoop]);

  // The gate OPENING is a start. This is the line that was missing: `start`
  // was returned, and documented, and never called by anything — so auto-record
  // was a checkbox that produced a "Recording" badge exactly never, and no
  // webinar was ever recorded.
  //
  // Keyed on `enabled` alone, through a ref, deliberately. `start` changes
  // identity whenever a source stream does, and an effect that listed it would
  // re-run on every camera toggle — including the one in the End button's
  // teardown, where it would start a brand-new recording on the way out of a
  // room whose recording had just been flushed. One start per time the gate
  // opens is the contract; `start` itself is idempotent on top of that.
  useEffect(() => {
    if (!enabled) return;
    startRef.current();
  }, [enabled]);

  // The gate closing is a stop, not a pause: the host left the room, or was
  // demoted, and whatever has been recorded so far should be uploaded rather
  // than held.
  useEffect(() => {
    if (enabled) return;
    if (!runningRef.current && pendingUploadsRef.current === 0) return;
    void stop();
  }, [enabled, stop]);

  // A hook that survived a navigation between two events must not append one
  // webinar's segments to another's. That used to be a line in the effect
  // above, and it was dead code: the effect opens with `if (enabled) return`,
  // and a recorder that is mid-run under a new `eventId` is by definition
  // still enabled — so the one situation the guard named was the one situation
  // in which it could not run. It is its own effect now, and it does not
  // consult `enabled` at all, because the recording that has to be closed out
  // belongs to the event we just left rather than the one we just arrived at.
  // The index reset that goes with it lives in `start`, not here: the old
  // run's last segment may still be between `onstop` and its upload, and it
  // reads its number from the counter at that moment.
  useEffect(() => {
    const startedUnder = runEventIdRef.current;
    if (startedUnder === null || startedUnder === eventId) return;
    if (!runningRef.current && pendingUploadsRef.current === 0) return;
    void stop();
  }, [eventId, stop]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // Synchronous, and not awaited: an unmount cleanup cannot wait on a
      // network upload. `teardown` still stops the recorder, so the in-flight
      // segment gets its one best-effort attempt on the way out.
      teardown();
    };
  }, [teardown]);

  return { state, uploaded, seconds, error, start, stop };
}

// ---------------------------------------------------------------------------
// Drawing helpers — pure, and module-level so the hook body stays readable
// ---------------------------------------------------------------------------

/** Monotonic; never the wall clock, which a clock correction can move backwards. */
function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

/**
 * An off-screen source element.
 *
 * `muted` is not cosmetic and not optional: an unmuted element playing the
 * host's own microphone is a feedback loop through their speakers, in a room
 * where they are on a live call. `playsInline` keeps iOS from taking the
 * element fullscreen when it starts playing.
 */
function sourceVideo(): HTMLVideoElement {
  const el = document.createElement("video");
  el.muted = true;
  el.autoplay = true;
  el.playsInline = true;
  return el;
}

function attach(el: HTMLVideoElement | null, stream: MediaStream | null) {
  if (!el) return;
  if (el.srcObject === (stream ?? null)) return;
  el.srcObject = stream ?? null;
  // An off-screen element still needs an explicit play(): autoplay policy
  // allows it because the element is muted, but nothing else is going to ask.
  if (stream) void el.play?.().catch(() => {});
}

/** Has this element decoded anything we can draw? */
function ready(el: HTMLVideoElement | null): el is HTMLVideoElement {
  return !!el && el.readyState >= 2 && el.videoWidth > 0 && el.videoHeight > 0;
}

type Box = { x: number; y: number; w: number; h: number };

/** Letterbox `video` inside `box`, preserving its aspect ratio. */
function drawContain(ctx: CanvasRenderingContext2D, video: HTMLVideoElement, box: Box) {
  const scale = Math.min(box.w / video.videoWidth, box.h / video.videoHeight);
  const w = video.videoWidth * scale;
  const h = video.videoHeight * scale;
  try {
    ctx.drawImage(video, box.x + (box.w - w) / 2, box.y + (box.h - h) / 2, w, h);
  } catch {
    // `drawImage` throws if the element's frame is not decodable at this
    // instant — a resolution change on a screen share does it. One dropped
    // frame, and the next tick is 40ms away.
  }
}

function cardMessage(cameraOn: boolean, el: HTMLVideoElement | null): string {
  if (!cameraOn) return "Camera off";
  return el && el.srcObject ? "Camera starting" : "No camera";
}

/**
 * The placeholder that stands in for a source there is nothing to draw from.
 *
 * Drawn every frame rather than left as a frozen last frame, which is what the
 * canvas would otherwise hold: a host who turns their camera off would appear
 * to sit motionless for the rest of the recording, which reads as a broken
 * file rather than as a deliberate choice they made.
 *
 * A plain system font stack, not the app's `.font-display`: canvas text does
 * not participate in font loading, so naming VT323 here would silently fall
 * back to whatever the platform's default is — and differ between the host's
 * machine and everyone's expectations.
 */
function drawCard(ctx: CanvasRenderingContext2D, text: string) {
  const w = 520;
  const h = 160;
  const x = (CANVAS_WIDTH - w) / 2;
  const y = (CANVAS_HEIGHT - h) / 2;
  ctx.fillStyle = CARD_FILL;
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = INSET_BORDER;
  ctx.lineWidth = 2;
  ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
  ctx.fillStyle = CARD_TEXT;
  ctx.font = `34px ${FONT_STACK}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, CANVAS_WIDTH / 2, CANVAS_HEIGHT / 2);
}

/** What the host's error sentences call the thing that carries on regardless. */
function subject(mode: "solo" | "call"): "webinar" | "call" {
  return mode === "call" ? "call" : "webinar";
}

/**
 * One person in a 1:1 recording: their camera (contain-fitted) or a card
 * saying why there is no picture, with their name in the corner.
 *
 * Everything is clipped to the box. A long name, or a placeholder sentence in
 * a small inset, must not paint over the person beside them — in a two-person
 * recording that is half the picture.
 */
function drawPerson(
  ctx: CanvasRenderingContext2D,
  video: HTMLVideoElement | null,
  box: Box,
  name: string,
  placeholder: string,
  inset: boolean,
) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(box.x, box.y, box.w, box.h);
  ctx.clip();

  if (inset) {
    ctx.fillStyle = BACKDROP;
    ctx.fillRect(box.x, box.y, box.w, box.h);
  }
  if (video) {
    drawContain(ctx, video, box);
  } else {
    const size = Math.max(12, Math.round(Math.min(34, box.w / 18, box.h / 8)));
    ctx.font = `${size}px ${FONT_STACK}`;
    const textW = ctx.measureText(placeholder).width;
    const w = Math.min(box.w - 16, textW + size * 2);
    const h = size * 2.6;
    const x = box.x + (box.w - w) / 2;
    const y = box.y + (box.h - h) / 2;
    ctx.fillStyle = CARD_FILL;
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = CARD_TEXT;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(placeholder, box.x + box.w / 2, box.y + box.h / 2);
  }

  // The name tag. A recording watched back weeks later has no roster beside
  // it, so it is the only thing that says who each face was.
  const tag = inset ? 13 : 20;
  const pad = Math.round(tag * 0.5);
  ctx.font = `${tag}px ${FONT_STACK}`;
  const label = name || "Guest";
  const tagW = Math.min(box.w - pad * 2, ctx.measureText(label).width + pad * 2);
  const tagH = tag + pad * 2;
  const tx = box.x + pad;
  const ty = box.y + box.h - tagH - pad;
  ctx.fillStyle = TAG_FILL;
  ctx.fillRect(tx, ty, tagW, tagH);
  ctx.fillStyle = CARD_TEXT;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(label, tx + pad, ty + tagH / 2, tagW - pad * 2);

  if (inset) {
    ctx.strokeStyle = INSET_BORDER;
    ctx.lineWidth = 2;
    ctx.strokeRect(box.x + 1, box.y + 1, box.w - 2, box.h - 2);
  }
  ctx.restore();
}

/**
 * Turn a failed upload into one sentence the host can act on.
 *
 * Runs `getActionError` — `onSegment` is a server action on the other side of
 * the network boundary, where production strips the message — but inside its
 * own guard, because that helper deliberately re-throws framework control-flow
 * errors, and a throw from here would escape into a `MediaRecorder` callback
 * where nothing is listening.
 */
function uploadErrorText(err: unknown, failures: number): string {
  let detail = "Something went wrong.";
  try {
    detail = getActionError(err, "Something went wrong.");
  } catch {
    /* control-flow error; the generic sentence is fine */
  }
  const scale =
    failures === 1
      ? "A recording segment didn't upload"
      : `${failures} recording segments didn't upload`;
  return `${scale} — recording is still running. ${detail}`;
}
