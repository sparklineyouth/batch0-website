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
 * Auto-start (calls; webinars that record automatically): as soon as this tab
 * may record and is live, if nobody is recording — and again whenever the
 * room's lease comes free while it is still live, so a call goes on being
 * recorded when the person recording it leaves while others carry on. Not
 * after a deliberate Stop: this tab never restarts on its own once its person
 * pressed Stop, and the server refuses an automatic start in a room whose last
 * take was stopped on purpose (until someone records it again by hand).
 * Pressing Record always works. A take of this user's in another tab or
 * device is theirs to keep: this tab shows it and doesn't take it over —
 * except the take this very tab was making before a reload.
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

/**
 * Why a take stops. "stop": its person pressed Stop (the room then stays
 * unrecorded until someone presses Record). "leave": they are leaving, or the
 * room ended — someone else still in the room picks the recording up.
 */
export type StopReason = "stop" | "leave";

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
  /**
   * Resolves once the recorder's last chunk is captured. The Record/Stop
   * button calls `stop()`; a Leave/End path that flushes the recording before
   * stopping the devices calls `stop("leave")`. (Leaving — `live` going false —
   * and unmounting stop with "leave" by themselves.)
   */
  stop: (reason?: StopReason) => Promise<void>;
  /** Resolve once every captured part is uploaded and the take finalized (bounded, 90 s). */
  drain: () => Promise<void>;
  /** Parts not yet uploaded (+1 while the take is being finished). Keep the unload guard armed while > 0. */
  pendingUploads: number;
};

const DRAIN_TIMEOUT_MS = 90_000;
/** A refused start's "who is recording" is trusted this long without the server confirming it. */
const CONFLICT_TTL_MS = 30_000;
/** Waits before retrying an automatic start that failed; after the last, only Record starts one. */
const AUTO_RETRY_MS = [5_000, 15_000, 30_000, 60_000];

type Holder = { sessionId: string | null; id: string; name: string; startedAt: string };
type StartOutcome = "started" | "busy" | "stopped" | "unavailable" | "error" | "skipped";

/** The take this tab is making, by room — what a reload of the same tab replaces. */
const storageKey = (roomKey: string) => `batch0:recording:${roomKey}`;
function readStored(roomKey: string): string | null {
  try {
    return window.sessionStorage.getItem(storageKey(roomKey));
  } catch {
    return null;
  }
}
function writeStored(roomKey: string, sessionId: string | null) {
  try {
    if (sessionId) window.sessionStorage.setItem(storageKey(roomKey), sessionId);
    else window.sessionStorage.removeItem(storageKey(roomKey));
  } catch {
    // Private mode: a reload then waits for the old lease to go stale.
  }
}

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
  const [conflict, setConflict] = useState<Holder | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const takeRef = useRef<Take | null>(null);
  const startingRef = useRef(false);
  /** Stop was asked for while the lease request was still out. */
  const cancelRef = useRef(false);
  const mountedRef = useRef(true);
  const roomKey = `${kind}:${roomId}`;
  /** The take this tab was making when it was reloaded, if one may still hold the lease. */
  const reloadedFrom = useRef<string | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    reloadedFrom.current = readStored(roomKey);
    return () => {
      mountedRef.current = false;
    };
  }, [roomKey]);

  // A fresh server answer supersedes what a refused start told us; and what
  // it told us is only trusted for a while without one.
  useEffect(() => setConflict(null), [serverRecording?.sessionId]);
  useEffect(() => {
    if (!conflict) return;
    const t = setTimeout(() => setConflict(null), CONFLICT_TTL_MS);
    return () => clearTimeout(t);
  }, [conflict]);

  const [supported, setSupported] = useState(true);
  useEffect(() => setSupported(recorderMime() !== null), []);

  // Auto-start bookkeeping (see the header).
  const userStopped = useRef(false);
  const autoBlocked = useRef(false);
  const autoTried = useRef(false);
  const autoFailures = useRef(0);
  const [autoNonce, setAutoNonce] = useState(0);

  const stop = useCallback(async (reason: StopReason = "stop") => {
    if (reason === "stop") userStopped.current = true;
    if (startingRef.current) cancelRef.current = true;
    const take = takeRef.current;
    if (!take || !take.capturing) return;
    if (mountedRef.current) setState("stopping");
    await take.stop(reason);
  }, []);

  const startTake = useCallback(
    async (auto: boolean): Promise<StartOutcome> => {
      if (!canRecord || takeRef.current || startingRef.current) return "skipped";
      const mime = recorderMime();
      if (!mime) {
        setState("unavailable");
        return "unavailable";
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
          body: JSON.stringify({ kind, roomId, mime, auto, replaces: reloadedFrom.current }),
        }).catch(() => null);
        const body = res ? await res.json().catch(() => ({})) : {};
        if (!res || !res.ok) {
          if (!mountedRef.current) return "skipped";
          if (res?.status === 409 && body.by) {
            setConflict({
              sessionId: typeof body.sessionId === "string" ? body.sessionId : null,
              id: body.by.id,
              name: body.by.name,
              startedAt: body.startedAt,
            });
            setState("idle");
            return "busy";
          }
          if (res?.status === 409 && body.stopped) {
            setState("idle");
            return "stopped";
          }
          if (res?.status === 503 && body.unavailable) {
            setState("unavailable");
            return "unavailable";
          }
          autoFailures.current += 1;
          setState("error");
          setError(body.error || "Couldn't start recording. Try again.");
          return "error";
        }

        reloadedFrom.current = null;
        ownTakes.add(body.sessionId);
        writeStored(roomKey, body.sessionId);
        const take: Take = new Take(body.sessionId, mime, {
          endRecorder: () => recorder.end(),
          onPending: (n) => {
            if (mountedRef.current) setPending(n);
          },
          // Failures count until a take gets a part through: a take that dies
          // as soon as it starts must not be restarted forever.
          onUploaded: () => {
            autoFailures.current = 0;
          },
          onFatal: (message) => {
            autoFailures.current += 1;
            if (!mountedRef.current) return;
            setState("error");
            setError(message);
          },
          onDone: () => {
            if (takeRef.current === take) takeRef.current = null;
            if (activeTakes.get(roomKey) === take) activeTakes.delete(roomKey);
            if (readStored(roomKey) === take.sessionId) writeStored(roomKey, null);
            if (!mountedRef.current) return;
            setStartedAt(null);
            setState((s) => (s === "error" ? s : "idle"));
            setAutoNonce((n) => n + 1);
          },
        });
        takeRef.current = take;
        activeTakes.set(roomKey, take);
        if (cancelRef.current || !mountedRef.current) {
          // Left (or stopped) before the lease came back: close the empty take.
          void take.stop(userStopped.current ? "stop" : "leave");
          return "started";
        }
        try {
          recorder.begin({
            mime,
            onChunk: (chunk) => take.push(chunk),
            onError: (message) => take.fail(message),
          });
        } catch (err) {
          take.fail(err instanceof Error ? err.message : "Couldn't start recording.");
          return "error";
        }
        setStartedAt(Date.now());
        setState("recording");
        return "started";
      } finally {
        startingRef.current = false;
      }
    },
    [canRecord, kind, roomId, roomKey, recorder],
  );

  /** Record, pressed. */
  const start = useCallback(async () => {
    userStopped.current = false;
    autoFailures.current = 0;
    await startTake(false);
  }, [startTake]);

  const mine = state === "recording";
  // The server may still name a take of this tab's (it is saving, or the
  // answer predates its finish): that is never someone else recording.
  const serverOther =
    serverRecording && !ownTakes.has(serverRecording.sessionId)
      ? {
          sessionId: serverRecording.sessionId,
          id: serverRecording.byUserId,
          name: serverRecording.byName,
          startedAt: serverRecording.startedAt,
        }
      : null;
  const holder: Holder | null = serverOther ?? conflict;
  const holderKey = holder ? (holder.sessionId ?? `?${holder.id}`) : null;
  // This tab's own take from before a reload: the lease it may take back.
  const holderIsMyReload =
    !!holder && holder.id === selfId && !!holder.sessionId && holder.sessionId === reloadedFrom.current;

  // Someone recording again re-opens what a deliberate Stop closed.
  useEffect(() => {
    if (holderKey && !holderIsMyReload) autoBlocked.current = false;
  }, [holderKey, holderIsMyReload]);

  // Auto-start: whenever this tab may record, is live, and the lease is free.
  useEffect(() => {
    if (!autoStart || !canRecord || !live || !supported) return;
    if (userStopped.current || autoBlocked.current) return;
    if (state !== "idle" && state !== "error") return;
    if (takeRef.current || startingRef.current) return;
    if (holderKey && !holderIsMyReload) return;
    if (autoFailures.current > AUTO_RETRY_MS.length) return;
    const delay = !autoTried.current
      ? 0
      : autoFailures.current > 0
        ? AUTO_RETRY_MS[autoFailures.current - 1]
        : // The lease just came free: several tabs may want it. The server
          // settles who gets it; the spread keeps them from all asking at once.
          500 + Math.random() * 3000;
    const t = setTimeout(() => {
      autoTried.current = true;
      void startTake(true).then((outcome) => {
        if (outcome === "stopped") autoBlocked.current = true;
        if (outcome === "busy") autoFailures.current = 0;
        if (mountedRef.current) setAutoNonce((n) => n + 1);
      });
    }, delay);
    return () => clearTimeout(t);
  }, [autoStart, canRecord, live, supported, state, holderKey, holderIsMyReload, autoNonce, startTake]);

  // Leaving the room (or losing the right to record) stops the take.
  useEffect(() => {
    if (!live || !canRecord) void stop("leave");
  }, [live, canRecord, stop]);

  // So does unmounting; the take's upload carries on without the component.
  useEffect(() => () => void stop("leave"), [stop]);

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

  const by = mine
    ? { id: selfId, name: selfName || "You" }
    : holder
      ? { id: holder.id, name: holder.id === selfId ? "you, in another tab" : holder.name }
      : null;
  const since = mine ? startedAt : holder ? Date.parse(holder.startedAt) : null;

  return {
    state: !supported && canRecord ? "unavailable" : state,
    mine,
    by,
    // Read when rendered — no per-second state here, which would re-render
    // the whole room every second of a take. A running clock re-renders
    // itself (the room kit's RecClock).
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
/** Every take this tab has started (ids only). */
const ownTakes = new Set<string>();
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
  private reason: StopReason = "leave";
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
      /** A part landed. */
      onUploaded: () => void;
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
  async stop(reason: StopReason) {
    if (this.phase !== "capturing") return;
    this.phase = "closing";
    this.reason = reason;
    this.hooks.onPending(this.pendingCount());
    await this.hooks.endRecorder();
    await this.chain;
    if (this.phase !== "closing") return;
    this.seal();
    this.phase = "draining";
    this.hooks.onPending(this.pendingCount());
    void this.pump();
  }

  /** The recorder failed for good: keep what was captured. Not a decision to stop — others may pick it up. */
  fail(message: string) {
    if (this.phase === "done") return;
    this.hooks.onFatal(message);
    void this.stop("leave");
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
        this.hooks.onUploaded();
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
      const res = await post(`/api/recordings/${this.sessionId}/finish`, { reason: this.reason });
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
