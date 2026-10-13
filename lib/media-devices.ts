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

/**
 * What to tell someone whose device switch failed. The previous device stays
 * live, so every message says what to try, not that the call is broken.
 */
export function deviceSwitchError(
  name: string | null | undefined,
  kind: "audio" | "video",
): string {
  const noun = kind === "audio" ? "microphone" : "camera";
  if (name === "NotReadableError" || name === "AbortError") {
    return `That ${noun} is busy — close any other app using it, then pick it again.`;
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return `That ${noun} isn't connected any more.`;
  }
  if (name === "NotAllowedError" || name === "SecurityError") {
    return `The browser blocked that ${noun}. Allow it in the address bar, then pick it again.`;
  }
  return `Couldn't switch to that ${noun}. Still using the previous one.`;
}
