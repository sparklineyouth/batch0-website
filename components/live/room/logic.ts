/**
 * Pure helpers behind the room UI: copy decisions, audio level maths, deck
 * geometry and caching. Import-free so lib/live-room-logic.test.ts can run them
 * under `node --test`.
 */

// ── Audio levels ────────────────────────────────────────────────────────────

/** RMS (time-domain, -1..1) → a 0..1 meter level on a -60..-10 dB scale. */
export function levelFromRms(rms: number): number {
  if (!(rms > 0)) return 0;
  const db = 20 * Math.log10(rms);
  return Math.min(1, Math.max(0, (db + 60) / 50));
}

/** Above this RMS a voice counts as speaking (≈ -36 dBFS). */
const SPEAKING_ON_RMS = 0.016;
/** Below this it counts as quiet (hysteresis, ≈ -40 dBFS). */
const SPEAKING_OFF_RMS = 0.01;
/** Quiet for this long before the ring goes off, so it doesn't flicker between words. */
export const SPEAKING_HOLD_MS = 700;

export type SpeakingState = { speaking: boolean; lastLoudAt: number };

/** One detector tick. */
export function nextSpeaking(prev: SpeakingState, rms: number, now: number): SpeakingState {
  if (rms >= SPEAKING_ON_RMS) return { speaking: true, lastLoudAt: now };
  if (rms >= SPEAKING_OFF_RMS && prev.speaking) return { speaking: true, lastLoudAt: now };
  if (prev.speaking && now - prev.lastLoudAt < SPEAKING_HOLD_MS) return prev;
  return { speaking: false, lastLoudAt: prev.lastLoudAt };
}

// ── Copy ────────────────────────────────────────────────────────────────────

/** "1:05", "12:40", "1:02:03". */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** "Ana", "Ana and Ben", "Ana, Ben and Cy", "Ana, Ben and 3 others". */
export function joinNames(names: readonly string[]): string {
  const list = names.map((n) => n.trim()).filter(Boolean);
  if (list.length === 0) return "";
  if (list.length === 1) return list[0];
  if (list.length === 2) return `${list[0]} and ${list[1]}`;
  if (list.length === 3) return `${list[0]}, ${list[1]} and ${list[2]}`;
  return `${list[0]}, ${list[1]} and ${list.length - 2} others`;
}

export type GreenRoomCta = {
  label: string;
  /** One short line under the button, or null. */
  detail: string | null;
  /** Joining as a co-host: camera and mic start off. */
  cohost: boolean;
};

/**
 * The green room's main button. Webinar hosts start the webinar when nobody is
 * live (before the go-live window they only enter the room: a rehearsal),
 * otherwise join as a co-host; `hosting` null means "not known yet" and is
 * treated as nobody live (the server still decides who is primary). A host
 * who still holds the main stage (`primary`: back within moments of leaving)
 * rejoins as the host, camera and mic as they set them.
 */
export function greenRoomCta(opts: {
  kind: "webinar" | "call";
  broadcaster: boolean;
  hosting: readonly string[] | null | undefined;
  /** Before the go-live window: going in is a rehearsal, not a start. */
  rehearsal?: boolean;
  /** This host holds the main-stage seat (getHostingStatus). */
  primary?: boolean;
}): GreenRoomCta {
  if (opts.kind === "call") return { label: "Join call", detail: null, cohost: false };
  if (!opts.broadcaster) return { label: "Join", detail: null, cohost: false };
  const names = (opts.hosting ?? []).filter((n) => n.trim());
  if (names.length === 0) {
    return { label: opts.rehearsal ? "Enter room" : "Start webinar", detail: null, cohost: false };
  }
  if (opts.primary) {
    return {
      label: "Rejoin as host",
      detail: `${joinNames(names)} ${names.length === 1 ? "is" : "are"} in the room`,
      cohost: false,
    };
  }
  return {
    label: "Join as co-host",
    detail: `${joinNames(names)} ${names.length === 1 ? "is" : "are"} hosting`,
    cohost: true,
  };
}

// ── Stage notice ────────────────────────────────────────────────────────────

export type StageNoticeKind = "connecting" | "waiting" | "starts" | "away" | "reconnecting" | "failed";

type PeerLink = "idle" | "connecting" | "live" | "reconnecting" | "failed" | "left";

/**
 * What an empty stage says. In order: the join failed; the join hasn't landed;
 * a link that was up is coming back; a host is here but this viewer's link to
 * them is still being set up (ICE/TURN); the host was on air and isn't now;
 * the webinar starts later; nobody is on air.
 */
export function stageNotice(input: {
  joinFailed: boolean;
  joined: boolean;
  /** Remote broadcasters as the engine lists them. */
  peers: readonly { state: PeerLink; seenLive: boolean }[];
  /** A host has been on air this session. */
  hadHost: boolean;
  liveStartedAt: string | null;
  startsAt: string | null | undefined;
  now: number;
}): StageNoticeKind {
  if (input.joinFailed) return "failed";
  if (!input.joined) return "connecting";
  const dialling = input.peers.filter(
    (p) => p.state === "idle" || p.state === "connecting" || p.state === "failed",
  );
  if (input.peers.some((p) => p.state === "reconnecting") || dialling.some((p) => p.seenLive)) {
    return "reconnecting";
  }
  if (dialling.length > 0) return "connecting";
  if (input.hadHost || input.liveStartedAt) return "away";
  if (input.startsAt && Date.parse(input.startsAt) > input.now) return "starts";
  return "waiting";
}

// ── Recording control ───────────────────────────────────────────────────────

export type RecordControl =
  | { kind: "record"; busy: boolean }
  | { kind: "recording"; busy: boolean }
  | { kind: "other"; label: string };

/**
 * The record control for a person who may record. useRoomRecording reports
 * another host's take as `by` with this tab's state left idle/error (`mine`
 * stays false), so "someone else" is `by` without `mine`.
 */
export function recordControl(
  r: { state: string; mine: boolean; by: { id: string; name: string } | null },
  selfId: string,
): RecordControl {
  const busy = r.state === "starting" || r.state === "stopping";
  if (r.mine) return { kind: "recording", busy };
  if (r.by && !busy) {
    return {
      kind: "other",
      label: r.by.id === selfId ? "Recording in another tab" : `Recording by ${r.by.name || "another host"}`,
    };
  }
  return { kind: "record", busy };
}

/**
 * What to say when getDisplayMedia fails. Null means stay silent (the person
 * cancelled the picker). `message` is the DOMException message, which is how
 * Chrome tells a macOS permission block ("Permission denied by system") from a
 * cancel ("Permission denied").
 */
export function screenShareError(
  name: string | null | undefined,
  message: string | null | undefined,
  platform: "mac" | "windows" | "other" = "other",
): string | null {
  const msg = (message ?? "").toLowerCase();
  if (name === "NotAllowedError" || name === "SecurityError") {
    if (msg.includes("by system")) {
      return platform === "mac"
        ? "Your Mac blocked screen sharing. Allow your browser in System Settings › Privacy & Security › Screen Recording, then restart it."
        : "Your computer blocked screen sharing. Allow your browser to record the screen in system settings.";
    }
    return null;
  }
  if (name === "AbortError") return null;
  if (name === "NotReadableError") {
    return "Couldn't capture that screen. Close other apps that are recording it and try again.";
  }
  if (name === "NotFoundError") return "Nothing to share was found.";
  if (name === "NotSupportedError" || name === "TypeError") {
    return "This browser can't share its screen. Try Chrome, Edge or Firefox on a computer.";
  }
  return "Couldn't start screen sharing. Try again.";
}

// ── Deck geometry ───────────────────────────────────────────────────────────

/** The slide's box inside a `boxW` × `boxH` frame, scaled to fit and centred (letterboxed). */
export function fitRect(
  srcW: number,
  srcH: number,
  boxW: number,
  boxH: number,
): { x: number; y: number; w: number; h: number; scale: number } {
  if (!(srcW > 0) || !(srcH > 0)) return { x: 0, y: 0, w: boxW, h: boxH, scale: 1 };
  const scale = Math.min(boxW / srcW, boxH / srcH);
  const w = Math.round(srcW * scale);
  const h = Math.round(srcH * scale);
  return { x: Math.floor((boxW - w) / 2), y: Math.floor((boxH - h) / 2), w, h, scale };
}

/** Where a key press moves a deck: an absolute 1-based page, "stop", or null. */
export function deckKeyAction(
  key: string,
  page: number,
  count: number,
): number | "stop" | null {
  if (count <= 0) return key === "Escape" ? "stop" : null;
  const clamp = (n: number) => Math.min(count, Math.max(1, n));
  switch (key) {
    case "ArrowRight":
    case "ArrowDown":
    case "PageDown":
    case " ":
    case "Spacebar":
      return clamp(page + 1);
    case "ArrowLeft":
    case "ArrowUp":
    case "PageUp":
      return clamp(page - 1);
    case "Home":
      return 1;
    case "End":
      return count;
    case "Escape":
      return "stop";
    default:
      return null;
  }
}

/** Is this a PDF? Checks the "%PDF-" signature in the first bytes. */
export function looksLikePdf(head: Uint8Array): boolean {
  // The header may follow up to 1024 bytes of junk (spec allows it).
  const max = Math.min(head.length - 5, 1024);
  for (let i = 0; i <= max; i++) {
    if (
      head[i] === 0x25 &&
      head[i + 1] === 0x50 &&
      head[i + 2] === 0x44 &&
      head[i + 3] === 0x46 &&
      head[i + 4] === 0x2d
    ) {
      return true;
    }
  }
  return false;
}

/**
 * A small LRU keyed by number with an eviction callback (closes ImageBitmaps).
 * Pure bookkeeping: what to keep is up to the caller.
 */
export class Lru<V> {
  private map = new Map<number, V>();
  private readonly cap: number;
  private readonly onEvict?: (key: number, value: V) => void;
  constructor(cap: number, onEvict?: (key: number, value: V) => void) {
    this.cap = cap;
    this.onEvict = onEvict;
  }
  get size(): number {
    return this.map.size;
  }
  has(key: number): boolean {
    return this.map.has(key);
  }
  get(key: number): V | undefined {
    const v = this.map.get(key);
    if (v !== undefined) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }
  set(key: number, value: V, keep: readonly number[] = []): void {
    const old = this.map.get(key);
    if (old !== undefined && old !== value) this.onEvict?.(key, old);
    this.map.delete(key);
    this.map.set(key, value);
    for (const k of this.map.keys()) {
      if (this.map.size <= this.cap) break;
      if (keep.includes(k)) continue;
      const v = this.map.get(k) as V;
      this.map.delete(k);
      this.onEvict?.(k, v);
    }
  }
  clear(): void {
    for (const [k, v] of this.map) this.onEvict?.(k, v);
    this.map.clear();
  }
}
