/**
 * The cameras, microphones and speakers the live room's pickers offer.
 *
 * Built from `navigator.mediaDevices.enumerateDevices()`, but this file takes
 * plain objects rather than `MediaDeviceInfo` so it stays import-free and has
 * tests (lib/media-devices.test.ts). The browser half — enumerating, switching,
 * remembering — lives in components/live/use-local-media.ts and
 * components/live/audio-output.ts.
 *
 * Two browser behaviours shape it:
 *
 *   - Before camera/mic permission, Safari and Firefox list devices with an
 *     EMPTY deviceId (and every browser blanks the labels). Those entries can't
 *     be selected — there is nothing to pass to getUserMedia — so they are
 *     dropped rather than offered as "Camera 1" that does nothing.
 *   - A device with an id but no label is real, just unnamed until permission
 *     lands; it is offered under a numbered fallback name.
 */

export type DeviceOption = { deviceId: string; label: string };

export type DeviceLists = {
  mics: DeviceOption[];
  cameras: DeviceOption[];
  speakers: DeviceOption[];
};

export const NO_DEVICES: DeviceLists = { mics: [], cameras: [], speakers: [] };

type RawDevice = { kind: string; deviceId: string; label?: string | null };

const NOUN: Record<string, string> = {
  audioinput: "Microphone",
  videoinput: "Camera",
  audiooutput: "Speaker",
};

/** Group a device enumeration into the three pickers, in the browser's order. */
export function groupDevices(list: readonly RawDevice[]): DeviceLists {
  const out: DeviceLists = { mics: [], cameras: [], speakers: [] };
  const seen = new Set<string>();
  for (const d of list) {
    const bucket =
      d.kind === "audioinput"
        ? out.mics
        : d.kind === "videoinput"
          ? out.cameras
          : d.kind === "audiooutput"
            ? out.speakers
            : null;
    if (!bucket || !d.deviceId) continue;
    const key = `${d.kind}:${d.deviceId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const label = (d.label ?? "").trim() || `${NOUN[d.kind]} ${bucket.length + 1}`;
    bucket.push({ deviceId: d.deviceId, label });
  }
  return out;
}

/**
 * Which option a picker shows as chosen: the device actually in use when it is
 * listed, else the browser's "default" entry, else the first. Never an id the
 * list doesn't contain — a <select> given one renders blank and looks broken.
 */
export function selectedDevice(
  options: readonly DeviceOption[],
  activeId: string | null | undefined,
): string {
  if (activeId && options.some((o) => o.deviceId === activeId)) return activeId;
  if (options.some((o) => o.deviceId === "default")) return "default";
  return options[0]?.deviceId ?? "";
}

/** Where a person turns a blocked device back on. */
const ALLOW_IN = {
  browser: "the address bar",
  system: "System Settings › Privacy",
} as const;

/**
 * Was this denial the OPERATING SYSTEM's rather than the browser's? Chrome on
 * macOS answers "Permission denied by system" when the browser itself has no
 * camera / microphone permission, and the fix is then System Settings, not
 * the address bar.
 */
export function isSystemDenial(
  err: { name?: unknown; message?: unknown } | null | undefined,
): boolean {
  return (
    !!err &&
    err.name === "NotAllowedError" &&
    typeof err.message === "string" &&
    /by system/i.test(err.message)
  );
}

/**
 * What to tell someone whose device switch failed. The previous device stays
 * live, so every message says what to try, not that the call is broken.
 */
export function deviceSwitchError(
  name: string | null | undefined,
  kind: "audio" | "video",
  system = false,
): string {
  const noun = kind === "audio" ? "microphone" : "camera";
  if (name === "NotReadableError" || name === "AbortError") {
    return `That ${noun} is in use by another app. Close it, then pick the ${noun} again.`;
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return `That ${noun} isn't connected any more.`;
  }
  if (name === "NotAllowedError" || name === "SecurityError") {
    return `That ${noun} is blocked. Allow it in ${system ? ALLOW_IN.system : ALLOW_IN.browser}, then pick it again.`;
  }
  return `Couldn't switch to that ${noun}. Still using the previous one.`;
}

// ---------------------------------------------------------------------------
// Camera / microphone status
// ---------------------------------------------------------------------------

/** One device's state: "off" until it has been acquired (or after stop). */
export type DeviceStatus = "ready" | "denied" | "missing" | "error" | "off";

/** The stream as a whole (useLocalMedia().status). */
export type MediaStatus =
  | "idle"
  | "requesting"
  | "ready"
  | "denied"
  | "missing"
  | "unsupported"
  | "error";

/** What a getUserMedia failure means for the device asked for. */
export function mediaErrorKind(name: string | null | undefined): DeviceStatus {
  if (name === "NotAllowedError" || name === "SecurityError") return "denied";
  if (
    name === "NotFoundError" ||
    name === "OverconstrainedError" ||
    name === "DevicesNotFoundError"
  ) {
    return "missing";
  }
  // NotReadableError / AbortError: the device exists but another app (or the
  // OS) holds it. Anything unknown reads the same way: try again later.
  return "error";
}

/** The stream's status from its two devices: ready while either one is. */
export function overallMediaStatus(cam: DeviceStatus, mic: DeviceStatus): MediaStatus {
  if (cam === "ready" || mic === "ready") return "ready";
  if (cam === "off" && mic === "off") return "idle";
  if (cam === "denied" || mic === "denied") return "denied";
  const absent = (s: DeviceStatus) => s === "missing" || s === "off";
  if (absent(cam) && absent(mic)) return "missing";
  return "error";
}

type NotReady = Exclude<DeviceStatus, "ready" | "off">;

function isNotReady(s: DeviceStatus): s is NotReady {
  return s === "denied" || s === "missing" || s === "error";
}

/** One device's problem, as a sentence that says what to do. */
function problem(noun: "Camera" | "Microphone", s: NotReady, system: boolean): string {
  if (s === "denied") {
    return `${noun} blocked: allow it in ${system ? ALLOW_IN.system : ALLOW_IN.browser}.`;
  }
  if (s === "missing") return `No ${noun.toLowerCase()} found.`;
  return `${noun} is in use by another app.`;
}

/**
 * One line saying which device is not working, or null when nothing is
 * wrong. Terse, and never "the call is broken": with one device down the
 * other still works. `system` marks a denial that came from the operating
 * system (isSystemDenial), which is fixed somewhere else.
 */
export function mediaStatusText(
  cam: DeviceStatus,
  mic: DeviceStatus,
  system: { camera?: boolean; mic?: boolean } = {},
): string | null {
  const camSystem = !!system.camera;
  const micSystem = !!system.mic;
  if (isNotReady(cam) && isNotReady(mic)) {
    if (cam === mic && camSystem === micSystem) {
      if (cam === "denied") {
        return `Camera and microphone blocked: allow them in ${camSystem ? ALLOW_IN.system : ALLOW_IN.browser}.`;
      }
      if (cam === "missing") return "No camera or microphone found.";
      return "Camera and microphone are in use by another app.";
    }
    return `${problem("Camera", cam, camSystem)} ${problem("Microphone", mic, micSystem)}`;
  }
  if (isNotReady(cam)) {
    return `${problem("Camera", cam, camSystem)}${mic === "ready" ? " You can still talk." : ""}`;
  }
  if (isNotReady(mic)) {
    return `${problem("Microphone", mic, micSystem)}${cam === "ready" ? " Your camera still works." : ""}`;
  }
  return null;
}
