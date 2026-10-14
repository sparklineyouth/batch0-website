"use client";
import { useEffect, useRef, useState } from "react";
import { Camera, Mic, Play, Square, Volume2 } from "lucide-react";
import { canPickSpeaker, setSpeakerId, useSpeakerId } from "@/components/live/audio-output";
import { groupDevices, selectedDevice, type DeviceOption } from "@/lib/media-devices";
import { useAudioLevel } from "../audio-levels";
import type { LocalMediaView } from "../types";
import { RoomButton, SELECT } from "../ui";
import { playTestSound, useMicTest } from "./tests";

/** The mic level, as a bar. A leaf: only it re-renders with the level. */
export function MicMeter({ stream, muted }: { stream: MediaStream | null; muted: boolean }) {
  const level = useAudioLevel(muted ? null : stream);
  return (
    <div className="flex items-center gap-2" data-testid="mic-meter">
      <div
        className="h-1.5 flex-1 overflow-hidden rounded-full bg-[#2a2a30]"
        role="meter"
        aria-label="Microphone level"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(level * 100)}
      >
        <div
          className="h-full rounded-full bg-[#FFBB00] transition-[width] duration-100 ease-linear"
          style={{ width: `${Math.round(level * 100)}%` }}
        />
      </div>
      {muted ? <span className="text-xs text-[#a1a1aa]">Muted</span> : null}
    </div>
  );
}

/** Speakers for people with no camera/mic stream (webinar viewers). */
function useSpeakerOptions(fromMedia: DeviceOption[] | null): DeviceOption[] {
  const [own, setOwn] = useState<DeviceOption[]>([]);
  useEffect(() => {
    if (fromMedia) return;
    const md = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
    if (!md?.enumerateDevices) return;
    let live = true;
    const read = () =>
      md
        .enumerateDevices()
        .then((list) => live && setOwn(groupDevices(list).speakers))
        .catch(() => {});
    void read();
    md.addEventListener?.("devicechange", read);
    return () => {
      live = false;
      md.removeEventListener?.("devicechange", read);
    };
  }, [fromMedia]);
  return fromMedia ?? own;
}

function Field({ icon, label, children }: { icon: React.ReactNode; label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <p className="flex items-center gap-1.5 text-xs font-medium text-[#a1a1aa]">
        <span className="[&>svg]:h-3.5 [&>svg]:w-3.5">{icon}</span>
        {label}
      </p>
      {children}
    </div>
  );
}

/**
 * Mic (picker, meter, 3-second test), camera picker, speaker (picker, test
 * sound). People who don't send media get the speaker part only.
 */
export function DeviceControls({ media }: { media: LocalMediaView | null }) {
  const speakerId = useSpeakerId();
  const speakers = useSpeakerOptions(media ? media.devices.speakers : null);
  const [sounding, setSounding] = useState(false);
  const mic = useMicTest(media?.stream ?? null, speakerId);
  const [pickable, setPickable] = useState(false);
  useEffect(() => setPickable(canPickSpeaker()), []);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  const testSound = () => {
    setSounding(true);
    void playTestSound(speakerId).finally(() => {
      if (mounted.current) setSounding(false);
    });
  };

  const hasMic = !!media?.stream?.getAudioTracks().length;
  const hasCam = !!media?.stream?.getVideoTracks().length;

  return (
    <div className="space-y-4" data-testid="device-controls">
      {media ? (
        <>
          <Field icon={<Mic />} label="Microphone">
            {media.devices.mics.length ? (
              <select
                className={SELECT}
                value={selectedDevice(media.devices.mics, media.micId)}
                onChange={(e) => media.setMic(e.target.value)}
                disabled={media.switching}
                aria-label="Microphone"
                data-testid="select-mic"
              >
                {media.devices.mics.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label}
                  </option>
                ))}
              </select>
            ) : (
              <p className="text-sm text-[#a1a1aa]">No microphone found.</p>
            )}
            {hasMic ? <MicMeter stream={media.stream} muted={!media.micOn} /> : null}
            {mic.supported && hasMic ? (
              <RoomButton
                variant="ghost"
                size="sm"
                className="-ml-2"
                onClick={mic.state === "idle" ? mic.start : mic.stop}
                disabled={!media.micOn}
                data-testid="mic-test"
              >
                {mic.state === "recording" ? (
                  <>
                    <Square className="h-3.5 w-3.5" /> Recording… {mic.left}
                  </>
                ) : mic.state === "playing" ? (
                  <>
                    <Square className="h-3.5 w-3.5" /> Playing back
                  </>
                ) : (
                  <>
                    <Mic className="h-3.5 w-3.5" /> Test mic
                  </>
                )}
              </RoomButton>
            ) : null}
          </Field>

          <Field icon={<Camera />} label="Camera">
            {media.devices.cameras.length ? (
              <select
                className={SELECT}
                value={selectedDevice(media.devices.cameras, media.cameraId)}
                onChange={(e) => media.setCamera(e.target.value)}
                disabled={media.switching || !hasCam}
                aria-label="Camera"
                data-testid="select-camera"
              >
                {media.devices.cameras.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label}
                  </option>
                ))}
              </select>
            ) : (
              <p className="text-sm text-[#a1a1aa]">No camera found.</p>
            )}
          </Field>
        </>
      ) : null}

      <Field icon={<Volume2 />} label="Speaker">
        {pickable && speakers.length > 0 ? (
          <select
            className={SELECT}
            value={selectedDevice(speakers, speakerId || null)}
            onChange={(e) => setSpeakerId(e.target.value)}
            aria-label="Speaker"
            data-testid="select-speaker"
          >
            {speakers.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label}
              </option>
            ))}
          </select>
        ) : (
          <p className="text-sm text-[#a1a1aa]">System default</p>
        )}
        <RoomButton
          variant="ghost"
          size="sm"
          className="-ml-2"
          onClick={testSound}
          busy={sounding}
          data-testid="speaker-test"
        >
          {sounding ? "Playing…" : (
            <>
              <Play className="h-3.5 w-3.5" /> Play test sound
            </>
          )}
        </RoomButton>
      </Field>

      {media?.deviceError ? (
        <p className="text-sm text-[#ffb224]" role="alert">
          {media.deviceError}
        </p>
      ) : null}
    </div>
  );
}
