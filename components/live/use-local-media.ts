"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  NO_DEVICES,
  deviceSwitchError,
  groupDevices,
  type DeviceLists,
} from "@/lib/media-devices";

/**
 * Remembered device choices. The green room and the call each open their own
 * stream (PreJoin releases its stream on unmount, and the room acquires again),
 * so a microphone picked before joining has to survive that hand-off — and the
 * next call — somewhere other than component state. Asked for as `ideal`, never
 * `exact`: a remembered headset that has since been unplugged falls back to the
 * default device instead of failing the whole getUserMedia.
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

/**
 * The viewer's own camera and microphone.
 *
 * This is deliberately plain `getUserMedia` and not part of any video SDK.
 * Device permission, the self-view, and the "is my mic actually picking me up"
 * check are the same work whichever provider we end up on, and they're the
 * part students get wrong — so they're worth owning rather than inheriting.
 * It also means the pre-join screen is fully functional before a single line
 * of provider code exists.
 *
 * Lifecycle: acquiring a stream is a permission prompt, so it happens once and
 * the tracks are then muted/unmuted in place. Re-acquiring on every toggle
 * would flash the camera light and, in Safari, re-prompt.
 */

export type MediaStatus =
  | "idle"
  /** Prompt is on screen — the browser is waiting on the user. */
  | "requesting"
  | "ready"
  | "denied"
  /** No camera/mic on the machine at all. */
  | "missing"
  /** Secure-context or unsupported-browser failure. */
  | "unsupported"
  | "error";

export type LocalMedia = {
  stream: MediaStream | null;
  status: MediaStatus;
  error: string | null;
  cameraOn: boolean;
  micOn: boolean;
  toggleCamera: () => void;
  toggleMic: () => void;
  /** 0–1, smoothed. Drives the mic meter. */
  level: number;
  start: () => void;
  stop: () => void;
  /**
   * Every microphone, camera and speaker the browser will name. Labels need
   * permission, so this fills in once the stream is up, and refreshes when a
   * device is plugged in or out.
   */
  devices: DeviceLists;
  /** The device actually in use, read off the live track — not merely the one asked for. */
  micId: string | null;
  cameraId: string | null;
  /** Switch microphone / camera mid-call. Peers and the recorder follow (see switchDevice). */
  setMic: (deviceId: string) => void;
  setCamera: (deviceId: string) => void;
  /** A switch is acquiring its new device. */
  switching: boolean;
  /** Why the last switch failed. The previous device is still live. */
  deviceError: string | null;
};

export function useLocalMedia({
  autoStart = false,
}: { autoStart?: boolean } = {}): LocalMedia {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [status, setStatus] = useState<MediaStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [cameraOn, setCameraOn] = useState(true);
  const [micOn, setMicOn] = useState(true);
  const [level, setLevel] = useState(0);
  const [devices, setDevices] = useState<DeviceLists>(NO_DEVICES);
  const [switching, setSwitching] = useState(false);
  const [deviceError, setDeviceError] = useState<string | null>(null);
  /** One device switch at a time; a second pick while one is acquiring waits its turn by being ignored. */
  const switchingRef = useRef(false);

  // Held in refs, not state: the cleanup path must be able to tear these down
  // without depending on a render having happened first.
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);
  /**
   * Bumped by every `stop()` — including the one unmount runs.
   *
   * `getUserMedia` can take seconds (a permission prompt, a slow camera), and
   * the person may Leave, End, press Back, or be torn down by a remount while
   * it is still pending. `stop()` then finds nothing to stop, and when the
   * promise resolves the stream used to be stored and metered anyway — on a
   * component that had already said goodbye, with nobody left to stop it. The
   * camera light stayed on over "You've left" until the tab closed. `start()`
   * captures the generation before the await and, if it has moved, stops the
   * new tracks on the spot and touches no state.
   */
  const genRef = useRef(0);
  /**
   * The start in flight, if any. Two overlapping starts (StrictMode's double
   * effect, or autoStart flipping while a manual start is pending) used to
   * open TWO streams and orphan the first, with its own AudioContext and rAF
   * loop; the second caller now just waits on the first.
   */
  const pendingRef = useRef<Promise<void> | null>(null);

  /** Cancel the meter's frame loop and close its audio graph, if any. */
  const releaseMeter = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    // Closing the context is what actually releases the audio graph; without
    // it Chrome keeps the tab's "in use" indicator lit after leaving a call.
    audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
  }, []);

  /** Re-read the device list. Harmless to call often; a failure keeps the last list. */
  const refreshDevices = useCallback(async () => {
    try {
      if (!navigator.mediaDevices?.enumerateDevices) return;
      setDevices(groupDevices(await navigator.mediaDevices.enumerateDevices()));
    } catch {
      /* keep what we had */
    }
  }, []);

  const stop = useCallback(() => {
    genRef.current += 1;
    pendingRef.current = null;
    releaseMeter();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setStream(null);
    setLevel(0);
    setStatus("idle");
  }, [releaseMeter]);

  const start = useCallback(async () => {
    if (streamRef.current) return;
    if (pendingRef.current) return pendingRef.current;

    // getUserMedia is undefined outside a secure context, which is the single
    // most common local-dev surprise: https://localhost works, http://192.168.x
    // from your phone does not.
    if (
      typeof navigator === "undefined" ||
      !navigator.mediaDevices?.getUserMedia
    ) {
      setStatus("unsupported");
      setError(
        "This browser can't open a camera here. Live video needs HTTPS — use localhost rather than a LAN IP address.",
      );
      return;
    }

    const gen = genRef.current;
    setStatus("requesting");
    setError(null);
    const run = (async () => {
      try {
        const mic = readPref(MIC_KEY);
        const camera = readPref(CAMERA_KEY);
        const s = await navigator.mediaDevices.getUserMedia({
          video: {
            width: { ideal: 1280 },
            height: { ideal: 720 },
            ...(camera ? { deviceId: { ideal: camera } } : {}),
          },
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            ...(mic ? { deviceId: { ideal: mic } } : {}),
          },
        });
        // Stopped (or unmounted) while the prompt was up. Release what we were
        // just handed and leave every piece of state exactly as stop() left it.
        if (gen !== genRef.current) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = s;
        setStream(s);
        setStatus("ready");
        // Adopt whatever the toggles were set to before the stream existed, so
        // joining with the camera pre-disabled doesn't briefly show a face.
        s.getVideoTracks().forEach((t) => (t.enabled = cameraOn));
        s.getAudioTracks().forEach((t) => (t.enabled = micOn));
        attachMeter(s);
        // Permission has just been granted, so the device list now has its
        // names — the pickers were empty (or unnamed) until this moment.
        void refreshDevices();
      } catch (err: any) {
        // A failure that lands after a stop belongs to a start nobody wants any
        // more — surfacing it would put "camera blocked" over "You've left".
        if (gen !== genRef.current) return;
        const name = err?.name ?? "";
        if (name === "NotAllowedError" || name === "SecurityError") {
          setStatus("denied");
          setError(
            "Camera and microphone are blocked. Allow them in your browser's address bar, then try again.",
          );
        } else if (
          name === "NotFoundError" ||
          name === "OverconstrainedError"
        ) {
          setStatus("missing");
          setError("No camera or microphone found on this device.");
        } else {
          setStatus("error");
          setError(err?.message ?? "Could not start your camera.");
        }
      } finally {
        if (gen === genRef.current) pendingRef.current = null;
      }
    })();
    pendingRef.current = run;
    return run;
    // cameraOn/micOn are read to seed track state; re-creating `start` when a
    // toggle flips would be pointless since it early-returns once a stream
    // exists.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** RMS level off an analyser node, smoothed so the meter doesn't strobe. */
  function attachMeter(s: MediaStream) {
    // Never two meters. A second attach (a restart after a device change) used
    // to leave the first AudioContext open and its rAF loop running forever.
    releaseMeter();
    try {
      const Ctx = window.AudioContext ?? (window as any).webkitAudioContext;
      if (!Ctx) return;
      const ctx: AudioContext = new Ctx();
      audioCtxRef.current = ctx;
      const source = ctx.createMediaStreamSource(s);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      const buf = new Uint8Array(analyser.frequencyBinCount);
      let smoothed = 0;

      const tick = () => {
        analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) {
          const v = (buf[i] - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / buf.length);
        // Speech RMS sits well under 0.5, so scale up before clamping or the
        // meter never leaves the first bar.
        const scaled = Math.min(1, rms * 4);
        smoothed = smoothed * 0.8 + scaled * 0.2;
        setLevel(smoothed);
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    } catch {
      // A missing AudioContext costs us the meter, nothing else. The call
      // still works, so this is not worth surfacing to the user.
    }
  }

  const toggleCamera = useCallback(() => {
    setCameraOn((on) => {
      const next = !on;
      streamRef.current?.getVideoTracks().forEach((t) => (t.enabled = next));
      return next;
    });
  }, []);

  const toggleMic = useCallback(() => {
    setMicOn((on) => {
      const next = !on;
      streamRef.current?.getAudioTracks().forEach((t) => (t.enabled = next));
      return next;
    });
  }, []);

  /**
   * Switch to another microphone or camera without leaving.
   *
   * Opens ONLY the new device, then publishes a NEW MediaStream holding it
   * plus the untouched track of the other kind, and stops the old track. A new
   * stream object rather than mutating the old one, on purpose: everything
   * downstream already follows `stream` by identity — the live session
   * re-attaches its senders with `replaceTrack` (no renegotiation, nobody
   * drops), the recorder re-wires its camera element and mic source, the
   * self-view swaps its srcObject, and the meter below is re-attached. Mutating
   * the stream in place would be invisible to all of them.
   *
   * The new track inherits the old one's on/off: switching cameras while the
   * camera is off must not light it. The old device is released only after the
   * new one is live, so a failed switch (busy, unplugged, refused) leaves the
   * call exactly as it was and says why. (Phones that can hold only one camera
   * mute the old track themselves when the new one opens.)
   */
  const switchDevice = useCallback(
    async (kind: "audio" | "video", deviceId: string) => {
      const current = streamRef.current;
      if (!current || !deviceId || switchingRef.current) return;
      const old = kind === "audio" ? current.getAudioTracks() : current.getVideoTracks();
      const live = old.find((t) => t.readyState === "live");
      if (live && live.getSettings().deviceId === deviceId) {
        writePref(kind === "audio" ? MIC_KEY : CAMERA_KEY, deviceId);
        return;
      }
      const gen = genRef.current;
      switchingRef.current = true;
      setSwitching(true);
      setDeviceError(null);
      try {
        const fresh = await navigator.mediaDevices.getUserMedia(
          kind === "audio"
            ? {
                audio: {
                  deviceId: { exact: deviceId },
                  echoCancellation: true,
                  noiseSuppression: true,
                },
              }
            : {
                video: {
                  deviceId: { exact: deviceId },
                  width: { ideal: 1280 },
                  height: { ideal: 720 },
                },
              },
        );
        const track = (kind === "audio" ? fresh.getAudioTracks() : fresh.getVideoTracks())[0];
        // Stopped, unmounted, or the stream replaced while the device opened:
        // nobody wants this track any more.
        if (!track || gen !== genRef.current || streamRef.current !== current) {
          fresh.getTracks().forEach((t) => t.stop());
          return;
        }
        track.enabled = old[0]?.enabled ?? true;
        const keep = kind === "audio" ? current.getVideoTracks() : current.getAudioTracks();
        const next = new MediaStream([...keep, track]);
        streamRef.current = next;
        setStream(next);
        old.forEach((t) => t.stop());
        if (kind === "audio") attachMeter(next);
        writePref(kind === "audio" ? MIC_KEY : CAMERA_KEY, deviceId);
        void refreshDevices();
      } catch (err: any) {
        if (gen === genRef.current) setDeviceError(deviceSwitchError(err?.name, kind));
      } finally {
        // Always cleared — a switch interrupted by stop() must not leave the
        // pickers disabled for the next start.
        switchingRef.current = false;
        setSwitching(false);
      }
    },
    // attachMeter is a plain function over refs; refreshDevices is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [refreshDevices],
  );

  // Plugging a device in or out changes what the pickers offer. And when the
  // device IN USE is the one that went (a headset unplugged mid-call), its
  // track has ended and the call has gone silent or black — move to the first
  // device of that kind that is still there, rather than leaving the person to
  // discover it from the other side's "I can't hear you".
  useEffect(() => {
    const md = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
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
  // before the recorder has flushed the final segment — the room stops the
  // devices itself, after the flush. Anyone who wants them off calls `stop()`.
  useEffect(() => {
    if (autoStart) void start();
  }, [autoStart, start]);

  // Always release the devices on unmount, however the page was left.
  useEffect(() => stop, [stop]);

  return {
    stream,
    status,
    error,
    cameraOn,
    micOn,
    toggleCamera,
    toggleMic,
    level,
    start: () => void start(),
    stop,
    devices,
    micId: stream?.getAudioTracks()[0]?.getSettings().deviceId ?? null,
    cameraId: stream?.getVideoTracks()[0]?.getSettings().deviceId ?? null,
    setMic: (deviceId: string) => void switchDevice("audio", deviceId),
    setCamera: (deviceId: string) => void switchDevice("video", deviceId),
    switching,
    deviceError,
  };
}
