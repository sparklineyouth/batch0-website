"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  NO_DEVICES,
  deviceSwitchError,
  groupDevices,
  isSystemDenial,
  mediaErrorKind,
  mediaStatusText,
  overallMediaStatus,
  type DeviceLists,
  type DeviceStatus,
  type MediaStatus,
} from "@/lib/media-devices";

/**
 * Remembered device choices. The green room and the call each open their own
 * stream (the green room releases its stream on unmount, and the room
 * acquires again), so a microphone picked before joining has to survive that
 * hand-off — and the next call — somewhere other than component state. Asked
 * for as `ideal`, never `exact`: a remembered headset that has since been
 * unplugged falls back to the default device instead of failing the request.
 */
const MIC_KEY = "batch0.live.mic";
const CAMERA_KEY = "batch0.live.camera";

function readPref(key: string): string | null {
  try {
    return window.localStorage.getItem(key) || null;
  } catch {
    return null;
  }
}

function writePref(key: string, deviceId: string | null | undefined): void {
  try {
    if (deviceId) window.localStorage.setItem(key, deviceId);
  } catch {
    /* remembered for this page only */
  }
}

/** What to ask for one kind; a remembered device is `ideal`, a picked one `exact`. */
function request(
  kind: "audio" | "video",
  deviceId: string | null,
  exact = false,
): MediaStreamConstraints {
  const device = deviceId
    ? { deviceId: exact ? { exact: deviceId } : { ideal: deviceId } }
    : {};
  return kind === "audio"
    ? { audio: { echoCancellation: true, noiseSuppression: true, ...device } }
    : { video: { width: { ideal: 1280 }, height: { ideal: 720 }, ...device } };
}

/**
 * The person's own camera and microphone.
 *
 * Acquiring is a permission prompt, so it happens once and tracks are then
 * enabled/disabled in place; re-acquiring on every toggle would flash the
 * camera light and, in Safari, re-prompt.
 *
 * DEGRADES PER DEVICE. A camera that is missing or held by another app (Zoom,
 * Teams) no longer costs the microphone, and the reverse: the combined request
 * is retried for each kind on its own, and `cameraStatus` / `micStatus` say
 * which one is missing and why. A permission denial is retried only for a kind
 * whose permission is already granted, so a dismissed prompt never turns into
 * two more prompts.
 *
 * A device that failed reads as OFF (`cameraOn` / `micOn` false), because it
 * is: nothing is being sent. Turning it on is a retry — one click, after
 * closing the app that held it — and a device that comes up on a retry (a
 * toggle, a pick, or `start` again) comes up on.
 *
 * Levels live in components/live/room/audio-levels.ts (`useAudioLevel`,
 * `useSpeaking`), read only by the leaf that draws them: a meter here
 * re-rendered the whole room on every animation frame.
 */

export type { DeviceStatus, MediaStatus };

export type LocalMedia = {
  stream: MediaStream | null;
  /**
   * The stream as a whole: "requesting" while the prompt is up, "ready" while
   * either device is live, otherwise why neither is (lib/media-devices.ts).
   */
  status: MediaStatus;
  /** Each device on its own: "off" until acquired (or after stop). */
  cameraStatus: DeviceStatus;
  micStatus: DeviceStatus;
  /** What went wrong, for whichever device is not ready. */
  error: string | null;
  /** On and sending. False for a device that failed (see cameraStatus). */
  cameraOn: boolean;
  micOn: boolean;
  /** Turning on a device that is not live (failed, unplugged) acquires it again. */
  toggleCamera: () => void;
  toggleMic: () => void;
  start: () => void;
  stop: () => void;
  /**
   * Every microphone, camera and speaker the browser will name. Labels need
   * permission, so this fills in once the stream is up, and refreshes when a
   * device is plugged in or out.
   */
  devices: DeviceLists;
  /** The device actually in use, read off the live track. */
  micId: string | null;
  cameraId: string | null;
  /** Switch (or acquire) microphone / camera mid-call. See switchDevice. */
  setMic: (deviceId: string) => void;
  setCamera: (deviceId: string) => void;
  /** A switch is acquiring its new device. */
  switching: boolean;
  /** Why the last switch failed. The previous device is still live. */
  deviceError: string | null;
};

type KindResult = {
  track: MediaStreamTrack | null;
  status: DeviceStatus;
  /** A denial by the operating system rather than the browser (isSystemDenial). */
  system: boolean;
};

type Kind = "audio" | "video";

/** Started and not working: denied, missing, or held by another app. */
function failed(s: DeviceStatus): boolean {
  return s === "denied" || s === "missing" || s === "error";
}

export function useLocalMedia({
  autoStart = false,
}: { autoStart?: boolean } = {}): LocalMedia {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [status, setStatus] = useState<MediaStatus>("idle");
  const [cameraStatus, setCameraStatus] = useState<DeviceStatus>("off");
  const [micStatus, setMicStatus] = useState<DeviceStatus>("off");
  const [error, setError] = useState<string | null>(null);
  const [cameraOn, setCameraOn] = useState(true);
  const [micOn, setMicOn] = useState(true);
  const [devices, setDevices] = useState<DeviceLists>(NO_DEVICES);
  const [switching, setSwitching] = useState(false);
  const [deviceError, setDeviceError] = useState<string | null>(null);
  /** One device switch at a time; a pick while one is acquiring is ignored. */
  const switchingRef = useRef(false);

  // Held in refs as well as state: the cleanup path and the async starts must
  // read the CURRENT values, not those of the render that created them (the
  // toggles used to be read from the first render, so a camera switched off
  // before the stream existed came up lit).
  const streamRef = useRef<MediaStream | null>(null);
  const cameraOnRef = useRef(true);
  const micOnRef = useRef(true);
  const cameraStatusRef = useRef<DeviceStatus>("off");
  const micStatusRef = useRef<DeviceStatus>("off");
  /** Per device: was its denial the operating system's? Picks the hint. */
  const systemRef = useRef<{ camera: boolean; mic: boolean }>({
    camera: false,
    mic: false,
  });
  /**
   * Bumped by every `stop()` — including the one unmount runs. A
   * getUserMedia still pending when the person leaves resolves into a newer
   * generation and stops its tracks unseen, instead of lighting a camera
   * nobody will ever stop.
   */
  const genRef = useRef(0);
  /** The start in flight; overlapping starts share it instead of opening two streams. */
  const pendingRef = useRef<Promise<void> | null>(null);

  /** Re-read the device list. Harmless to call often; a failure keeps the last list. */
  const refreshDevices = useCallback(async () => {
    try {
      if (!navigator.mediaDevices?.enumerateDevices) return;
      setDevices(groupDevices(await navigator.mediaDevices.enumerateDevices()));
    } catch {
      /* keep what we had */
    }
  }, []);

  /** Set one device's on/off, in the ref the async paths read and in state. */
  const setOn = useCallback((kind: Kind, on: boolean) => {
    if (kind === "video") {
      cameraOnRef.current = on;
      setCameraOn(on);
    } else {
      micOnRef.current = on;
      setMicOn(on);
    }
  }, []);

  /**
   * Publish a new stream (or none), with each device's status. A device that
   * failed reads as off; one that comes up after failing comes up on — it was
   * off because it failed, not because anyone switched it off.
   */
  const settle = useCallback(
    (next: MediaStream | null, cam: DeviceStatus, mic: DeviceStatus) => {
      for (const [kind, before, after] of [
        ["video", cameraStatusRef.current, cam],
        ["audio", micStatusRef.current, mic],
      ] as const) {
        if (failed(after)) setOn(kind, false);
        else if (after === "ready" && failed(before)) setOn(kind, true);
      }
      for (const t of next?.getTracks() ?? []) {
        t.enabled = t.kind === "video" ? cameraOnRef.current : micOnRef.current;
      }
      streamRef.current = next;
      cameraStatusRef.current = cam;
      micStatusRef.current = mic;
      setStream(next);
      setCameraStatus(cam);
      setMicStatus(mic);
      setStatus(overallMediaStatus(cam, mic));
      setError(mediaStatusText(cam, mic, systemRef.current));
    },
    [setOn],
  );

  const stop = useCallback(() => {
    genRef.current += 1;
    pendingRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    cameraStatusRef.current = "off";
    micStatusRef.current = "off";
    systemRef.current = { camera: false, mic: false };
    setStream(null);
    setStatus("idle");
    setCameraStatus("off");
    setMicStatus("off");
    setError(null);
  }, []);

  /** One kind on its own, mapped to a status. Never throws. */
  const acquireKind = useCallback(
    async (kind: Kind, deviceId?: string | null): Promise<KindResult> => {
      try {
        const s = await navigator.mediaDevices.getUserMedia(
          request(kind, deviceId ?? null),
        );
        const track =
          (kind === "audio" ? s.getAudioTracks() : s.getVideoTracks())[0] ??
          null;
        return { track, status: track ? "ready" : "missing", system: false };
      } catch (err: any) {
        return {
          track: null,
          status: mediaErrorKind(err?.name),
          system: isSystemDenial(err),
        };
      }
    },
    [],
  );

  const start = useCallback(async () => {
    if (streamRef.current) return;
    if (pendingRef.current) return pendingRef.current;

    // getUserMedia is undefined outside a secure context — the most common
    // local-dev surprise: https://localhost works, http://192.168.x does not.
    if (
      typeof navigator === "undefined" ||
      !navigator.mediaDevices?.getUserMedia
    ) {
      cameraStatusRef.current = "error";
      micStatusRef.current = "error";
      setOn("video", false);
      setOn("audio", false);
      setStatus("unsupported");
      setCameraStatus("error");
      setMicStatus("error");
      setError(
        "This browser can't open a camera here. Live video needs HTTPS.",
      );
      return;
    }

    const gen = genRef.current;
    setStatus("requesting");
    setError(null);
    const run = (async () => {
      const mic = readPref(MIC_KEY);
      const camera = readPref(CAMERA_KEY);
      let tracks: MediaStreamTrack[] = [];
      let cam: DeviceStatus = "off";
      let mc: DeviceStatus = "off";
      let system = { camera: false, mic: false };
      try {
        const s = await navigator.mediaDevices.getUserMedia({
          ...request("video", camera),
          ...request("audio", mic),
        });
        tracks = s.getTracks();
        cam = s.getVideoTracks().length > 0 ? "ready" : "missing";
        mc = s.getAudioTracks().length > 0 ? "ready" : "missing";
      } catch (err: any) {
        // Together failed: try each on its own, so a busy or missing camera
        // still leaves the mic (and the reverse).
        const both = mediaErrorKind(err?.name);
        const bothSystem = isSystemDenial(err);
        const retry = await retryableKinds(both);
        const [v, a] = await Promise.all([
          retry.video ? acquireKind("video", camera) : null,
          retry.audio ? acquireKind("audio", mic) : null,
        ]);
        cam = v ? v.status : both;
        mc = a ? a.status : both;
        system = {
          camera: v ? v.system : bothSystem,
          mic: a ? a.system : bothSystem,
        };
        tracks = [v?.track, a?.track].filter((t): t is MediaStreamTrack => !!t);
      }
      // Stopped (or unmounted) while the prompt was up: release what we were
      // handed and leave every piece of state exactly as stop() left it.
      if (gen !== genRef.current) {
        tracks.forEach((t) => t.stop());
        return;
      }
      systemRef.current = system;
      settle(tracks.length > 0 ? new MediaStream(tracks) : null, cam, mc);
      // Permission has just been granted, so the device list now has names.
      if (tracks.length > 0) void refreshDevices();
    })().finally(() => {
      if (gen === genRef.current) pendingRef.current = null;
    });
    pendingRef.current = run;
    return run;
  }, [acquireKind, refreshDevices, setOn, settle]);

  /**
   * Switch to another microphone or camera without leaving — or acquire one
   * that is not live at all (it was busy, missing or denied at start, or was
   * unplugged).
   *
   * Opens ONLY the new device, then publishes a NEW MediaStream holding it
   * plus the untouched track of the other kind, and stops the old track.
   * Everything downstream follows `stream` by identity — the live session
   * re-attaches its senders with `replaceTrack` (no renegotiation), the
   * recorder re-wires, the self-view swaps its srcObject. The new track
   * inherits the old one's on/off, and the old device is released only after
   * the new one is live, so a failed switch leaves the call exactly as it was
   * and says why. Acquiring a device that was not live and failing again
   * updates its status (and why) instead.
   *
   * Resolves "ok" when the device is live, "failed" when it could not be
   * opened, and "skipped" when nothing was attempted (another switch is in
   * flight, or the room went away meanwhile).
   */
  const switchDevice = useCallback(
    async (
      kind: Kind,
      deviceId: string | null,
    ): Promise<"ok" | "failed" | "skipped"> => {
      const current = streamRef.current;
      if (switchingRef.current) return "skipped";
      const old = current
        ? kind === "audio"
          ? current.getAudioTracks()
          : current.getVideoTracks()
        : [];
      const live = old.find((t) => t.readyState === "live");
      if (deviceId && live && live.getSettings().deviceId === deviceId) {
        writePref(kind === "audio" ? MIC_KEY : CAMERA_KEY, deviceId);
        return "ok";
      }
      const gen = genRef.current;
      switchingRef.current = true;
      setSwitching(true);
      setDeviceError(null);
      try {
        let track: MediaStreamTrack | null = null;
        let failure: { name: string; system: boolean } | null = null;
        try {
          const fresh = await navigator.mediaDevices.getUserMedia(
            deviceId
              ? request(kind, deviceId, true)
              : request(
                  kind,
                  readPref(kind === "audio" ? MIC_KEY : CAMERA_KEY),
                ),
          );
          track =
            (kind === "audio"
              ? fresh.getAudioTracks()
              : fresh.getVideoTracks())[0] ?? null;
        } catch (err: any) {
          failure = { name: err?.name ?? "Error", system: isSystemDenial(err) };
        }
        // Stopped, unmounted, or the stream replaced while the device opened.
        if (gen !== genRef.current || streamRef.current !== current) {
          track?.stop();
          return "skipped";
        }
        const which = kind === "video" ? "camera" : "mic";
        if (!track) {
          setDeviceError(deviceSwitchError(failure?.name, kind, failure?.system));
          if (!live) {
            // Nothing was working to fall back on: this device's status is
            // the news (and reads it as off).
            systemRef.current = { ...systemRef.current, [which]: !!failure?.system };
            const status = failure ? mediaErrorKind(failure.name) : "missing";
            settle(
              current,
              kind === "video" ? status : cameraStatusRef.current,
              kind === "audio" ? status : micStatusRef.current,
            );
          }
          return "failed";
        }
        track.enabled =
          old[0]?.enabled ??
          (kind === "video" ? cameraOnRef.current : micOnRef.current);
        const keep = current
          ? kind === "audio"
            ? current.getVideoTracks()
            : current.getAudioTracks()
          : [];
        const next = new MediaStream([...keep, track]);
        old.forEach((t) => t.stop());
        systemRef.current = { ...systemRef.current, [which]: false };
        settle(
          next,
          kind === "video" ? "ready" : cameraStatusRef.current,
          kind === "audio" ? "ready" : micStatusRef.current,
        );
        writePref(
          kind === "audio" ? MIC_KEY : CAMERA_KEY,
          track.getSettings().deviceId ?? deviceId,
        );
        void refreshDevices();
        return "ok";
      } finally {
        // Always cleared — a switch interrupted by stop() must not leave the
        // pickers disabled for the next start.
        switchingRef.current = false;
        setSwitching(false);
      }
    },
    [refreshDevices, settle],
  );

  /**
   * Flip one device. Turning on a device that is not live — it failed at
   * start (and so reads off), or was unplugged — is a retry: the other app
   * may have let go of it since. A retry that fails leaves it off.
   */
  const toggle = useCallback(
    (kind: Kind) => {
      const onRef = kind === "video" ? cameraOnRef : micOnRef;
      const statusRef = kind === "video" ? cameraStatusRef : micStatusRef;
      const next = !onRef.current;
      setOn(kind, next);
      const tracks =
        (kind === "video"
          ? streamRef.current?.getVideoTracks()
          : streamRef.current?.getAudioTracks()) ?? [];
      tracks.forEach((t) => (t.enabled = next));
      // Before start (status "off") this only records the choice: start
      // applies it to whatever it acquires.
      const started = statusRef.current !== "off" || !!streamRef.current;
      if (next && started && !tracks.some((t) => t.readyState === "live")) {
        void switchDevice(kind, null).then((result) => {
          if (result === "failed") setOn(kind, false);
        });
      }
    },
    [setOn, switchDevice],
  );
  const toggleCamera = useCallback(() => toggle("video"), [toggle]);
  const toggleMic = useCallback(() => toggle("audio"), [toggle]);

  // Plugging a device in or out changes what the pickers offer. When the
  // device IN USE is the one that went (a headset unplugged mid-call), move to
  // the first device of that kind that is still there.
  useEffect(() => {
    const md =
      typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
    if (!md?.addEventListener) return;
    const onChange = async () => {
      await refreshDevices();
      const s = streamRef.current;
      if (!s || !md.enumerateDevices) return;
      let list: MediaDeviceInfo[] = [];
      try {
        list = await md.enumerateDevices();
      } catch {
        return;
      }
      const grouped = groupDevices(list);
      const audio = s.getAudioTracks()[0];
      const video = s.getVideoTracks()[0];
      if (audio && audio.readyState === "ended" && grouped.mics[0]) {
        await switchDevice("audio", grouped.mics[0].deviceId);
      }
      if (video && video.readyState === "ended" && grouped.cameras[0]) {
        await switchDevice("video", grouped.cameras[0].deviceId);
      }
    };
    const handler = () => void onChange();
    md.addEventListener("devicechange", handler);
    return () => md.removeEventListener("devicechange", handler);
  }, [refreshDevices, switchDevice]);

  // `autoStart` going true starts the devices; going FALSE does not stop
  // them. The live room depends on that: when a webinar is ended under a
  // host, its gate flips first, and a stop here would kill the camera and mic
  // before the recorder has flushed — the room stops the devices itself.
  useEffect(() => {
    if (autoStart) void start();
  }, [autoStart, start]);

  // Always release the devices on unmount, however the page was left.
  useEffect(() => stop, [stop]);

  const startCb = useCallback(() => void start(), [start]);
  const setMic = useCallback(
    (deviceId: string) => void switchDevice("audio", deviceId),
    [switchDevice],
  );
  const setCamera = useCallback(
    (deviceId: string) => void switchDevice("video", deviceId),
    [switchDevice],
  );

  return useMemo(
    () => ({
      stream,
      status,
      cameraStatus,
      micStatus,
      error,
      cameraOn,
      micOn,
      toggleCamera,
      toggleMic,
      start: startCb,
      stop,
      devices,
      micId: stream?.getAudioTracks()[0]?.getSettings().deviceId ?? null,
      cameraId: stream?.getVideoTracks()[0]?.getSettings().deviceId ?? null,
      setMic,
      setCamera,
      switching,
      deviceError,
    }),
    [
      stream,
      status,
      cameraStatus,
      micStatus,
      error,
      cameraOn,
      micOn,
      toggleCamera,
      toggleMic,
      startCb,
      stop,
      devices,
      setMic,
      setCamera,
      switching,
      deviceError,
    ],
  );
}

/**
 * Which kinds are worth asking for on their own after the combined request
 * failed. Busy or missing hardware: both (one of them is usually fine). A
 * permission denial: only a kind whose permission is already granted — the
 * person may have blocked just the camera — so a dismissed prompt is not
 * followed by two more.
 */
async function retryableKinds(
  failed: DeviceStatus,
): Promise<{ audio: boolean; video: boolean }> {
  if (failed !== "denied") return { audio: true, video: true };
  const granted = async (name: string) => {
    try {
      const p = await navigator.permissions?.query({
        name,
      } as PermissionDescriptor);
      return p?.state === "granted";
    } catch {
      return false;
    }
  };
  const [audio, video] = await Promise.all([
    granted("microphone"),
    granted("camera"),
  ]);
  return { audio, video };
}
