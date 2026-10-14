"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { recorderMime, useRecorder, type RecorderPerson } from "@/components/live/use-recorder";
import { WebmScanner, type Cue } from "@/lib/recording-webm";
import {
  containerFor,
  HEARTBEAT_MS,
  PART_MAX_BYTES,
  PART_TARGET_MS,
  retryDelayMs,
  UNSENT_BYTES_CAP,
} from "@/lib/recording-parts";

/**
 * Recording a live room: one continuous take at a time, under a server lease.
 *
 *   start   POST /api/recordings takes the room's lease (409: someone else
 *           holds it — `by` says who), then ONE MediaRecorder starts
 *           (use-recorder.ts) and runs until Stop, Leave or End.
 *   record  its byte stream is cut into numbered parts (~10 s / 8 MB) and
 *           uploaded strictly in order, each through a URL the server signs
 *           for that index (/api/recordings/<id>/part, which also renews the
 *           lease). Failures retry with backoff and never skip an index;
 *           unsent parts wait in memory up to UNSENT_BYTES_CAP. Every chunk
 *           also passes through a WebmScanner, which notes where each
 *           keyframe Cluster starts — the server turns those into the file's
 *           Cues, so the finished recording seeks.
 *   stop    the recorder stops (resolves once its last chunk is captured);
 *           the remaining parts upload in the background and the take is
 *           finished (/finish), which releases the lease. `drain()` waits for
 *           that, bounded. A tab with a take still recording or uploading
 *           prompts before it closes, and the upload outlives the component.
 *
 * Calls auto-start when the first staff member is live; webinars when the
 * event records automatically. Auto-start fires once per mount, and only
 * takes the lease if nobody holds it — a host who joins while a co-host is
 * recording sees "Recording by <name>", and after that recording is manual.
 */

export type ServerRecording = {
  sessionId: string;
  byUserId: string;
  byName: string;
  startedAt: string;
} | null;

export type RoomRecordingRemote = {
  peerId: string;
  name: string;
  streams: { camera?: MediaStream; screen?: MediaStream; audio?: MediaStream };
};

export type RoomRecordingState =
  | "idle"
  | "starting"
  | "recording"
  | "stopping"
  | "error"
  | "unavailable";

export type RoomRecording = {
  state: RoomRecordingState;
  /** This tab is the recorder. */
  mine: boolean;
  by: { id: string; name: string } | null;
  /**
   * How long the room's take has run, as of when it is read (a getter). The
   * hook does not re-render every second for it: show a running clock from a
   * small component with its own timer.
   */
  readonly elapsedMs: number;
  error: string | null;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  /** Resolve once every captured part is uploaded and the take finalized (bounded, 90 s). */
  drain: () => Promise<void>;
  /** Parts not yet uploaded (+1 while the take is being finished). Keep the unload guard armed while > 0. */
  pendingUploads: number;
};

const DRAIN_TIMEOUT_MS = 90_000;

export function useRoomRecording(opts: {
  kind: "webinar" | "call";
  roomId: string;
  canRecord: boolean;
  autoStart: boolean;
  live: boolean;
  serverRecording: ServerRecording;
  selfId: string;
  localStream: MediaStream | null;
  screenStream: MediaStream | null;
  cameraOn: boolean;
  micOn: boolean;
  selfName: string;
  remotes: RoomRecordingRemote[];
  layout: { mainId: string | null; mainIsPresentation: boolean };
}): RoomRecording {
  const {
    kind,
    roomId,
    canRecord,
    autoStart,
    live,
    serverRecording,
    selfId,
    localStream,
    screenStream,
    cameraOn,
    selfName,
    remotes,
    layout,
  } = opts;

  const people = useMemo<RecorderPerson[]>(
    () => [
      {
        id: selfId || "self",
        name: selfName || "Host",
        camera: localStream,
        screen: screenStream,
        // A muted mic is a disabled track: it records the silence the room heard.
        audio: localStream,
        cameraOn,
      },
      ...remotes.map((r) => ({
        id: r.peerId,
        name: r.name || "Guest",
        camera: r.streams.camera ?? null,
        screen: r.streams.screen ?? null,
        audio: r.streams.audio ?? null,
        // The engine hands over only slots that are carrying media.
        cameraOn: !!r.streams.camera,
      })),
    ],
    [selfId, selfName, localStream, screenStream, cameraOn, remotes],
  );
  const recorder = useRecorder({ people, layout });

  const [state, setState] = useState<RoomRecordingState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(0);
  const [conflict, setConflict] = useState<{ id: string; name: string; startedAt: string } | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const takeRef = useRef<Take | null>(null);
  const startingRef = useRef(false);
  /** Stop was asked for while the lease request was still out. */
  const cancelRef = useRef(false);
  const mountedRef = useRef(true);
  const roomKey = `${kind}:${roomId}`;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // A fresh server answer supersedes what a refused start told us.
  useEffect(() => setConflict(null), [serverRecording?.sessionId]);

  const [supported, setSupported] = useState(true);
  useEffect(() => setSupported(recorderMime() !== null), []);

  const stop = useCallback(async () => {
    if (startingRef.current) cancelRef.current = true;
    const take = takeRef.current;
    if (!take || !take.capturing) return;
    if (mountedRef.current) setState("stopping");
    await take.stop();
  }, []);

  const start = useCallback(async () => {
    if (!canRecord || takeRef.current || startingRef.current) return;
    const mime = recorderMime();
    if (!mime) {
      setState("unavailable");
      return;
    }
    startingRef.current = true;
    cancelRef.current = false;
    setState("starting");
    setError(null);
    try {
      // A take of this room still uploading in this tab (a remount) goes first.
      await activeTakes.get(roomKey)?.finished;
      const res = await fetch("/api/recordings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind, roomId, mime }),
      }).catch(() => null);
      const body = res ? await res.json().catch(() => ({})) : {};
      if (!res || !res.ok) {
        if (!mountedRef.current) return;
        if (res?.status === 409 && body.by) {
          setConflict({ id: body.by.id, name: body.by.name, startedAt: body.startedAt });
          setState("idle");
        } else if (res?.status === 503 && body.unavailable) {
          setState("unavailable");
        } else {
          setState("error");
          setError(body.error || "Couldn't start recording. Try again.");
        }
        return;
      }

      const take: Take = new Take(body.sessionId, mime, {
        endRecorder: () => recorder.end(),
        onPending: (n) => {
          if (mountedRef.current) setPending(n);
        },
        onFatal: (message) => {
          if (!mountedRef.current) return;
          setState("error");
          setError(message);
        },
        onDone: () => {
          if (takeRef.current === take) takeRef.current = null;
          if (activeTakes.get(roomKey) === take) activeTakes.delete(roomKey);
          if (!mountedRef.current) return;
          setStartedAt(null);
          setState((s) => (s === "error" ? s : "idle"));
        },
      });
      takeRef.current = take;
      activeTakes.set(roomKey, take);
      if (cancelRef.current || !mountedRef.current) {
        // Left before the lease came back: close the empty take.
        void take.stop();
        return;
      }
      try {
        recorder.begin({
          mime,
          onChunk: (chunk) => take.push(chunk),
          onError: (message) => take.fail(message),
        });
      } catch (err) {
        take.fail(err instanceof Error ? err.message : "Couldn't start recording.");
        return;
      }
      setStartedAt(Date.now());
      setState("recording");
    } finally {
      startingRef.current = false;
    }
  }, [canRecord, kind, roomId, roomKey, recorder]);

  // Auto-start: once per mount, as soon as this tab may record and is live,
  // and only if nobody else is recording.
  const autoTried = useRef(false);
  useEffect(() => {
    if (!autoStart || !canRecord || !live || !supported || autoTried.current) return;
    autoTried.current = true;
    if (serverRecording && serverRecording.byUserId !== selfId) return;
    void start();
  }, [autoStart, canRecord, live, supported, serverRecording, selfId, start]);

  // Leaving the room (or losing the right to record) stops the take.
  useEffect(() => {
    if (!live || !canRecord) void stop();
  }, [live, canRecord, stop]);

  // So does unmounting; the take's upload carries on without the component.
  useEffect(() => () => void stop(), [stop]);

  const drain = useCallback(async () => {
    const take = takeRef.current ?? activeTakes.get(roomKey);
    if (!take) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      take.finished,
      new Promise<void>((r) => {
        timer = setTimeout(r, DRAIN_TIMEOUT_MS);
      }),
    ]);
    clearTimeout(timer);
  }, [roomKey]);

  const mine = state === "recording";
  const others =
    serverRecording && serverRecording.sessionId !== takeRef.current?.sessionId
      ? { id: serverRecording.byUserId, name: serverRecording.byName, startedAt: serverRecording.startedAt }
      : conflict;
  const by = mine ? { id: selfId, name: selfName || "You" } : others ? { id: others.id, name: others.name } : null;
  const since = mine ? startedAt : others ? Date.parse(others.startedAt) : null;

  return {
    state: !supported && canRecord ? "unavailable" : state,
    mine,
    by,
    // Read when rendered — no per-second state here, which would re-render
    // the whole room every second of a take. A running clock re-renders
    // itself (broadcast-room's RecBadge).
    get elapsedMs() {
      return since !== null && Number.isFinite(since) ? Math.max(0, Date.now() - since) : 0;
    },
    error,
    start,
    stop,
    drain,
    pendingUploads: pending,
  };
}

// ---------------------------------------------------------------------------
// One take's uploader — a plain object, so it outlives the component
// ---------------------------------------------------------------------------

/** Takes still recording or uploading in this tab, by room. */
const activeTakes = new Map<string, Take>();
/** Takes with work left: the tab asks before closing while any exist. */
const unsettled = new Set<Take>();

function guardUnload(e: BeforeUnloadEvent) {
  e.preventDefault();
  e.returnValue = "";
}

function setUnsettled(take: Take, busy: boolean) {
  const before = unsettled.size;
  if (busy) unsettled.add(take);
  else unsettled.delete(take);
  if (typeof window === "undefined") return;
  if (before === 0 && unsettled.size > 0) window.addEventListener("beforeunload", guardUnload);
  if (before > 0 && unsettled.size === 0) window.removeEventListener("beforeunload", guardUnload);
}

type Part = { index: number; blob: Blob; size: number; endMs: number; cues: Cue[] };

class Take {
  readonly sessionId: string;
  readonly finished: Promise<void>;
  /**
   * capturing  the recorder is running; chunks become parts
   * closing    stop asked for; waiting for the recorder's last chunk
   * draining   every part is sealed; uploading what is left, then /finish
   * done       finished, or nothing more can be sent
   */
  private phase: "capturing" | "closing" | "draining" | "done" = "capturing";
  private readonly container: "webm" | "mp4";
  private readonly startedAt = Date.now();
  private readonly scanner = new WebmScanner();
  private chain: Promise<void> = Promise.resolve();
  private chunks: Blob[] = [];
  private chunkBytes = 0;
  private partStarted = 0;
  private cues: Cue[] = [];
  private nextIndex = 0;
  private queue: Part[] = [];
  private pumping = false;
  /** The finish request is out: the server closing the lease is expected now. */
  private finishing = false;
  private beating = false;
  private lastContact = Date.now();
  private readonly heartbeat: ReturnType<typeof setInterval>;
  private resolveFinished!: () => void;

  constructor(
    sessionId: string,
    mime: string,
    private readonly hooks: {
      endRecorder: () => Promise<void>;
      onPending: (n: number) => void;
      onFatal: (message: string) => void;
      onDone: () => void;
    },
  ) {
    this.sessionId = sessionId;
    this.container = containerFor(mime) ?? "webm";
    this.finished = new Promise((r) => {
      this.resolveFinished = r;
    });
    setUnsettled(this, true);
    this.heartbeat = setInterval(() => void this.beat(), HEARTBEAT_MS / 2);
    if (typeof window !== "undefined") window.addEventListener("pagehide", this.onPagehide);
  }

  get capturing(): boolean {
    return this.phase === "capturing";
  }

  /** A chunk from the recorder, in order. */
  push(chunk: Blob) {
    if (this.phase === "done") return;
    this.chain = this.chain.then(async () => {
      try {
        if (this.phase === "done") return;
        if (this.container === "webm") {
          this.cues.push(...this.scanner.push(new Uint8Array(await chunk.arrayBuffer())));
        }
        if (this.chunks.length === 0) this.partStarted = Date.now();
        this.chunks.push(chunk);
        this.chunkBytes += chunk.size;
        if (Date.now() - this.partStarted >= PART_TARGET_MS || this.chunkBytes >= PART_MAX_BYTES) {
          this.seal();
        }
        if (this.phase === "capturing" && this.unsentBytes() > UNSENT_BYTES_CAP) {
          this.fail("Your connection can't keep up, so recording stopped. What was recorded is still uploading.");
        }
      } catch {
        // A chunk that can't be read is lost; the stream goes on.
      }
    });
  }

  /** Stop capturing: wait for the recorder's last chunk, seal it, upload the rest, finish. */
  async stop() {
    if (this.phase !== "capturing") return;
    this.phase = "closing";
    this.hooks.onPending(this.pendingCount());
    await this.hooks.endRecorder();
    await this.chain;
    if (this.phase !== "closing") return;
    this.seal();
    this.phase = "draining";
    this.hooks.onPending(this.pendingCount());
    void this.pump();
  }

  /** The recorder failed for good: keep what was captured. */
  fail(message: string) {
    if (this.phase === "done") return;
    this.hooks.onFatal(message);
    void this.stop();
  }

  private unsentBytes(): number {
    return this.queue.reduce((n, p) => n + p.size, 0) + this.chunkBytes;
  }

  private seal() {
    if (this.chunks.length === 0) return;
    const blob = new Blob(this.chunks, { type: this.container === "mp4" ? "video/mp4" : "video/webm" });
    // Recorded time at the end of this part: the stream's own block times for
    // WebM (exact), the wall clock otherwise.
    const endMs =
      this.container === "webm" && !this.scanner.failed
        ? this.scanner.maxTimeMs
        : Date.now() - this.startedAt;
    this.queue.push({ index: this.nextIndex++, blob, size: blob.size, endMs: Math.round(endMs), cues: this.cues });
    this.chunks = [];
    this.chunkBytes = 0;
    this.cues = [];
    this.hooks.onPending(this.pendingCount());
    void this.pump();
  }

  private pendingCount(): number {
    return this.queue.length + (this.phase === "capturing" ? 0 : 1);
  }

  /** Upload queued parts strictly in order; finish once every part is sealed and sent. */
  private async pump() {
    if (this.pumping || this.phase === "done") return;
    this.pumping = true;
    try {
      while (this.queue.length > 0) {
        if (!(await this.upload(this.queue[0]))) return;
        this.queue.shift();
        this.hooks.onPending(this.pendingCount());
      }
      if (this.phase === "draining") await this.finish();
    } finally {
      this.pumping = false;
    }
  }

  /** One part, retried until it lands; false once nothing more can be sent. */
  private async upload(part: Part): Promise<boolean> {
    for (let attempt = 0; ; attempt++) {
      if (this.phase === "done") return false;
      if (attempt > 0) await sleep(retryDelayMs(attempt - 1));
      const minted = await post(`/api/recordings/${this.sessionId}/part`, {
        index: part.index,
        size: part.size,
        endMs: part.endMs,
        cues: part.cues,
      });
      if ([400, 401, 404, 409].includes(minted.status)) {
        this.die();
        return false;
      }
      if (!minted.ok) continue;
      this.lastContact = Date.now();
      try {
        const { createClient } = await import("@/lib/supabase/client");
        const up = await createClient()
          .storage.from(minted.body.bucket)
          .uploadToSignedUrl(minted.body.path, minted.body.token, part.blob, {
            contentType: part.blob.type,
            upsert: true,
          });
        if (!up.error) return true;
      } catch {
        // A network failure: try again.
      }
    }
  }

  private async beat() {
    if (this.phase === "done" || this.finishing || Date.now() - this.lastContact < HEARTBEAT_MS) return;
    // One at a time: a slow server isn't sent a second beat before the first
    // is answered. (A long part upload still needs them — the lease is only
    // renewed by contact.)
    if (this.beating) return;
    this.beating = true;
    try {
      const res = await post(`/api/recordings/${this.sessionId}/part`, { heartbeat: true });
      if (res.ok) this.lastContact = Date.now();
      // A beat that crossed the finish request sees the take already closed.
      else if ((res.status === 409 || res.status === 404) && !this.finishing) this.die();
    } finally {
      this.beating = false;
    }
  }

  private async finish() {
    this.finishing = true;
    for (let attempt = 0; attempt < 5; attempt++) {
      if (attempt > 0) await sleep(retryDelayMs(attempt - 1));
      const res = await post(`/api/recordings/${this.sessionId}/finish`, {});
      // A 503 is the server's finalize failing; its sweep retries. The take is closed.
      if (res.ok || res.status === 503 || res.status === 404) break;
    }
    this.settle();
  }

  /** The lease is gone (stale, taken, signed out): nothing more can be sent. */
  private die() {
    if (this.phase === "done") return;
    this.hooks.onFatal("Recording stopped. What reached the server is saved.");
    const wasCapturing = this.phase === "capturing";
    this.queue = [];
    this.chunks = [];
    this.settle();
    if (wasCapturing) void this.hooks.endRecorder();
  }

  private settle() {
    if (this.phase === "done") return;
    this.phase = "done";
    clearInterval(this.heartbeat);
    if (typeof window !== "undefined") window.removeEventListener("pagehide", this.onPagehide);
    setUnsettled(this, false);
    this.hooks.onPending(0);
    this.hooks.onDone();
    this.resolveFinished();
  }

  /**
   * The tab is closing. With nothing in flight, say so now rather than after
   * the lease goes stale; with uploads in flight, the stale sweep (which
   * lets them land first) is the better ending.
   */
  private onPagehide = () => {
    if (this.queue.length === 0 && !this.pumping) {
      navigator.sendBeacon?.(
        `/api/recordings/${this.sessionId}/finish`,
        JSON.stringify({ interrupted: true }),
      );
    }
  };
}

async function post(url: string, body: unknown): Promise<{ ok: boolean; status: number; body: any }> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { ok: res.ok, status: res.status, body: await res.json().catch(() => ({})) };
  } catch {
    return { ok: false, status: 0, body: {} };
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
