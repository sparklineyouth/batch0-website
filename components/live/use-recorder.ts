"use client";
import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  MIME_CANDIDATES,
  RECORDING_AUDIO_BITRATE,
  RECORDING_CHUNK_MS,
  RECORDING_FPS,
  RECORDING_HEIGHT,
  RECORDING_KEYFRAME_MS,
  RECORDING_VIDEO_BITRATE,
  RECORDING_WIDTH,
} from "@/lib/recording-parts";
import { planStage, type Box, type StageLayout } from "@/lib/recording-layout";

/**
 * The recording's picture and sound, from inside one browser.
 *
 * batch0 Live has no media server (lib/live-signal.ts), so the room is
 * recorded where it is seen: one tab draws everyone on stage onto a 1280×720
 * canvas — the same main stage the room shows (lib/recording-layout.ts) — and
 * mixes every voice through an AudioContext into one track. ONE MediaRecorder
 * runs over that canvas track and that mixed track for the whole take. Nothing
 * it records from ever ends: people arriving or leaving, a device switch, a
 * screen share or slide deck starting and stopping, a camera turned off — the
 * canvas and the mix destination absorb all of it, so there is never a reason
 * to restart the recorder and never a seam in the file.
 *
 * Frames are driven by a Worker timer rather than requestAnimationFrame:
 * rAF stops in a hidden tab and main-thread timers are throttled, and a host
 * who switches to their notes must not freeze the recording. The canvas track
 * is captured at 0 fps and pushed with requestFrame() after each draw, where
 * the browser supports it, so a frame is recorded exactly when one is drawn.
 *
 * This hook only produces the byte stream (`onChunk`, one Blob a second, in
 * order); use-room-recording.ts owns the take, the lease and the upload.
 */

export type RecorderPerson = {
  id: string;
  name: string;
  camera: MediaStream | null;
  /** A screen share or slide deck (canvas) stream. */
  screen: MediaStream | null;
  audio: MediaStream | null;
  /**
   * Whether the camera is SENDING. A camera turned off is a disabled track
   * that keeps producing black frames; this draws "Camera off" instead.
   */
  cameraOn: boolean;
};

/** The first container/codec this browser can record, or null when it can't record. */
export function recorderMime(): string | null {
  if (typeof window === "undefined" || typeof window.MediaRecorder === "undefined") return null;
  for (const mime of MIME_CANDIDATES) {
    try {
      if (MediaRecorder.isTypeSupported(mime)) return mime;
    } catch {
      /* next */
    }
  }
  return null;
}

const BACKDROP = "#0b0b0d";
const CARD_FILL = "#17171a";
const CARD_TEXT = "#f4f4f5";
const INSET_BORDER = "#3f3f46";
const TAG_FILL = "rgba(0, 0, 0, 0.6)";
// Canvas text takes no part in font loading, so a system stack, not VT323.
const FONT_STACK = "ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif";
/** Longest end() waits for the recorder's last chunk. */
const STOP_TIMEOUT_MS = 3_000;

type Handlers = {
  mime: string;
  onChunk: (chunk: Blob) => void;
  onError: (message: string) => void;
};

type Rig = {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  track: MediaStreamTrack & { requestFrame?: () => void };
  recorder: MediaRecorder;
  audio: AudioContext;
  dest: MediaStreamAudioDestinationNode;
  nodes: Map<string, { trackId: string; node: MediaStreamAudioSourceNode }>;
  els: Map<string, { cam: HTMLVideoElement; screen: HTMLVideoElement }>;
  stopTicks: () => void;
};

export function useRecorder({
  people,
  layout,
}: {
  /** Everyone on stage, this tab's person first. */
  people: RecorderPerson[];
  /** What the room's main stage shows. */
  layout: StageLayout;
}): {
  /** Build the compositor and start recording. Throws an Error with a sentence when it can't. */
  begin: (handlers: Handlers) => void;
  /** Stop; resolves once the last chunk has been handed to onChunk (bounded). */
  end: () => Promise<void>;
} {
  const peopleRef = useRef(people);
  peopleRef.current = people;
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const rigRef = useRef<Rig | null>(null);

  /** Point each person's off-screen <video> elements at their current streams. */
  const syncSources = useCallback(() => {
    const rig = rigRef.current;
    if (!rig) return;
    const present = new Set<string>();
    for (const p of peopleRef.current) {
      present.add(p.id);
      let e = rig.els.get(p.id);
      if (!e) {
        e = { cam: sourceVideo(), screen: sourceVideo() };
        rig.els.set(p.id, e);
      }
      attach(e.cam, p.camera);
      attach(e.screen, p.screen);
    }
    for (const [id, e] of rig.els) {
      if (present.has(id)) continue;
      attach(e.cam, null);
      attach(e.screen, null);
      rig.els.delete(id);
    }
  }, []);

  /**
   * Keep the mix wired to exactly the voices on stage. A source node binds to
   * the track its stream held when it was made, so a node whose track changed
   * (a device switch) is rebuilt. The destination — the recorded track — is
   * never touched. Remote audio is the same stream the room plays through an
   * <audio> element, which Chrome needs before WebRTC audio reaches Web Audio.
   */
  const syncAudio = useCallback(() => {
    const rig = rigRef.current;
    if (!rig) return;
    const wanted = new Map<string, { stream: MediaStream; trackId: string }>();
    for (const p of peopleRef.current) {
      const t = p.audio?.getAudioTracks()[0];
      if (p.audio && t) wanted.set(p.id, { stream: p.audio, trackId: t.id });
    }
    for (const [key, entry] of rig.nodes) {
      if (wanted.get(key)?.trackId === entry.trackId) continue;
      try {
        entry.node.disconnect();
      } catch {
        /* already disconnected */
      }
      rig.nodes.delete(key);
    }
    for (const [key, want] of wanted) {
      if (rig.nodes.has(key)) continue;
      try {
        const node = rig.audio.createMediaStreamSource(want.stream);
        node.connect(rig.dest);
        rig.nodes.set(key, { trackId: want.trackId, node });
      } catch {
        // The track ended between the read and here; the next render retries.
      }
    }
  }, []);

  useEffect(() => {
    syncSources();
    syncAudio();
  }, [people, syncSources, syncAudio]);

  const compose = useCallback(() => {
    const rig = rigRef.current;
    if (!rig) return;
    const { ctx } = rig;
    ctx.fillStyle = BACKDROP;
    ctx.fillRect(0, 0, RECORDING_WIDTH, RECORDING_HEIGHT);
    const people = peopleRef.current;
    const byId = new Map(people.map((p) => [p.id, p]));
    const els = (id: string) => rig.els.get(id) ?? null;
    const plan = planStage(
      people.map((p) => ({ id: p.id, presenting: ready(els(p.id)?.screen ?? null) })),
      layoutRef.current,
      RECORDING_WIDTH,
      RECORDING_HEIGHT,
    );
    const person = (id: string, box: Box, inset: boolean) => {
      const p = byId.get(id);
      if (!p) return;
      const cam = els(id)?.cam ?? null;
      const live = p.cameraOn && ready(cam) ? cam : null;
      drawPerson(ctx, live, box, p.name, p.camera && p.cameraOn ? "Camera starting" : "Camera off", inset);
    };
    if (plan.kind === "presentation") {
      const screen = els(plan.presenter)?.screen ?? null;
      if (ready(screen)) drawContain(ctx, screen, plan.full);
      for (const i of plan.insets) person(i.id, i.box, true);
    } else if (plan.kind === "speaker") {
      person(plan.main, plan.full, false);
      for (const i of plan.insets) person(i.id, i.box, true);
    } else {
      for (const t of plan.tiles) person(t.id, t.box, false);
    }
    rig.track.requestFrame?.();
    // A context the browser suspended (a hidden tab, an audio interruption)
    // records silence until resumed.
    if (rig.audio.state !== "running") void rig.audio.resume().catch(() => {});
  }, []);

  const teardown = useCallback(() => {
    const rig = rigRef.current;
    if (!rig) return;
    rigRef.current = null;
    rig.stopTicks();
    if (rig.recorder.state !== "inactive") {
      try {
        rig.recorder.stop();
      } catch {
        /* already stopped */
      }
    }
    rig.track.stop();
    for (const e of rig.els.values()) {
      attach(e.cam, null);
      attach(e.screen, null);
    }
    for (const { node } of rig.nodes.values()) {
      try {
        node.disconnect();
      } catch {
        /* already disconnected */
      }
    }
    // Closing releases the audio graph; left open, Chrome keeps the tab's
    // microphone indicator lit after the call.
    void rig.audio.close().catch(() => {});
  }, []);

  const begin = useCallback(
    ({ mime, onChunk, onError }: Handlers) => {
      if (rigRef.current) throw new Error("Already recording.");
      if (typeof window === "undefined" || typeof window.MediaRecorder === "undefined") {
        throw new Error("This browser can't record. Try Chrome or Edge.");
      }
      const canvas = document.createElement("canvas");
      canvas.width = RECORDING_WIDTH;
      canvas.height = RECORDING_HEIGHT;
      const capture = (canvas as { captureStream?: (fps?: number) => MediaStream }).captureStream;
      const ctx = canvas.getContext("2d", { alpha: false });
      const AC =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (typeof capture !== "function" || !ctx || !AC) {
        throw new Error("This browser can't record. Try Chrome or Edge.");
      }
      const probe = capture.call(canvas, 0).getVideoTracks()[0] as Rig["track"] | undefined;
      // Pushed frames where the browser can (requestFrame), else a fixed rate.
      let track = probe;
      if (track && typeof track.requestFrame !== "function") {
        track.stop();
        track = capture.call(canvas, RECORDING_FPS).getVideoTracks()[0] as Rig["track"] | undefined;
      }
      if (!track) throw new Error("This browser can't record. Try Chrome or Edge.");

      const audio = new AC();
      const dest = audio.createMediaStreamDestination();
      const mix = new MediaStream([track, ...dest.stream.getAudioTracks()]);
      let recorder: MediaRecorder;
      try {
        recorder = new MediaRecorder(mix, {
          mimeType: mime,
          videoBitsPerSecond: RECORDING_VIDEO_BITRATE,
          audioBitsPerSecond: RECORDING_AUDIO_BITRATE,
          // Chrome: a keyframe every 2 s, which is what makes seeking quick.
          videoKeyFrameIntervalDuration: RECORDING_KEYFRAME_MS,
        } as MediaRecorderOptions);
      } catch {
        track.stop();
        void audio.close().catch(() => {});
        throw new Error("This browser wouldn't start a recorder.");
      }
      recorder.ondataavailable = (e: BlobEvent) => {
        if (e.data && e.data.size > 0) onChunk(e.data);
      };
      recorder.onerror = () => onError("The recorder stopped unexpectedly.");
      audio.onstatechange = () => {
        if (audio.state === "suspended") void audio.resume().catch(() => {});
      };

      rigRef.current = {
        canvas,
        ctx,
        track,
        recorder,
        audio,
        dest,
        nodes: new Map(),
        els: new Map(),
        stopTicks: startTicks(compose),
      };
      syncSources();
      syncAudio();
      // One frame before the recorder opens, so the file never starts on an
      // undrawn canvas.
      compose();
      void audio.resume().catch(() => {});
      try {
        recorder.start(RECORDING_CHUNK_MS);
      } catch {
        teardown();
        throw new Error("This browser wouldn't start a recorder.");
      }
    },
    [compose, syncAudio, syncSources, teardown],
  );

  const end = useCallback(async () => {
    const rig = rigRef.current;
    if (!rig) return;
    const { recorder } = rig;
    if (recorder.state === "inactive") {
      teardown();
      return;
    }
    await new Promise<void>((resolve) => {
      const guard = setTimeout(resolve, STOP_TIMEOUT_MS);
      // The final dataavailable fires before stop.
      recorder.addEventListener(
        "stop",
        () => {
          clearTimeout(guard);
          resolve();
        },
        { once: true },
      );
      try {
        recorder.stop();
      } catch {
        clearTimeout(guard);
        resolve();
      }
    });
    teardown();
  }, [teardown]);

  // An unmount mid-take stops the recorder; its last chunk still reaches
  // onChunk, and the take's uploader carries on without the component.
  useEffect(() => teardown, [teardown]);

  return useMemo(() => ({ begin, end }), [begin, end]);
}

/**
 * Call `tick` RECORDING_FPS times a second from a dedicated Worker's timer —
 * which, unlike rAF and main-thread timers, keeps its rate in a hidden tab —
 * falling back to setInterval where a Worker can't be made.
 */
function startTicks(tick: () => void): () => void {
  const ms = Math.round(1000 / RECORDING_FPS);
  try {
    const src = `let t=null;onmessage=(e)=>{clearInterval(t);if(e.data>0)t=setInterval(()=>postMessage(0),e.data)}`;
    const url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
    const worker = new Worker(url);
    URL.revokeObjectURL(url);
    worker.onmessage = () => tick();
    worker.postMessage(ms);
    return () => worker.terminate();
  } catch {
    const t = setInterval(tick, ms);
    return () => clearInterval(t);
  }
}

/** An off-screen source element. Muted: it may carry this tab's own mic. */
function sourceVideo(): HTMLVideoElement {
  const el = document.createElement("video");
  el.muted = true;
  el.autoplay = true;
  el.playsInline = true;
  return el;
}

function attach(el: HTMLVideoElement, stream: MediaStream | null) {
  if (el.srcObject === (stream ?? null)) return;
  el.srcObject = stream ?? null;
  if (stream) void el.play?.().catch(() => {});
}

function ready(el: HTMLVideoElement | null): el is HTMLVideoElement {
  return !!el && el.readyState >= 2 && el.videoWidth > 0 && el.videoHeight > 0;
}

/** Letterbox `video` inside `box`: contain, never crop. */
function drawContain(ctx: CanvasRenderingContext2D, video: HTMLVideoElement, box: Box) {
  const scale = Math.min(box.w / video.videoWidth, box.h / video.videoHeight);
  const w = video.videoWidth * scale;
  const h = video.videoHeight * scale;
  try {
    ctx.drawImage(video, box.x + (box.w - w) / 2, box.y + (box.h - h) / 2, w, h);
  } catch {
    // A frame mid-resize isn't drawable; the next tick is ~40 ms away.
  }
}

/** One person: their camera, or a card saying why not, and their name. Clipped to the box. */
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
    const w = Math.min(box.w - 16, ctx.measureText(placeholder).width + size * 2);
    const h = size * 2.6;
    ctx.fillStyle = CARD_FILL;
    ctx.fillRect(box.x + (box.w - w) / 2, box.y + (box.h - h) / 2, w, h);
    ctx.fillStyle = CARD_TEXT;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(placeholder, box.x + box.w / 2, box.y + box.h / 2);
  }
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
