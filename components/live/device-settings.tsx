"use client";
import { useEffect, useId, useState } from "react";
import { Mic, Video, Volume2 } from "lucide-react";
import type { LocalMedia } from "@/components/live/use-local-media";
import {
  canPickSpeaker,
  setSpeakerId,
  useSpeakerId,
} from "@/components/live/audio-output";
import { selectedDevice, type DeviceOption } from "@/lib/media-devices";

/**
 * Microphone, camera and speaker pickers — the green room's, and the call's
 * behind the control bar's settings button.
 *
 * Mic and camera switch the live device in place (useLocalMedia.setMic /
 * setCamera): the other side keeps the call and simply starts receiving the
 * new device, and the recording follows it. The speaker applies to every
 * remote voice at once (audio-output.ts). All three are remembered for the
 * next call.
 *
 * Renders nothing until there is a stream: before permission the browser
 * won't name the devices, and a list of "Camera 1, Camera 2" that may not even
 * be openable is worse than the "Waiting for camera…" already on screen.
 */
export function DeviceSettings({
  media,
  className = "",
}: {
  media: LocalMedia;
  className?: string;
}) {
  const speakerId = useSpeakerId();
  // Client-only: the server has no HTMLMediaElement, and guessing would be a
  // hydration mismatch.
  const [speakerSupported, setSpeakerSupported] = useState(false);
  useEffect(() => setSpeakerSupported(canPickSpeaker()), []);

  if (media.status !== "ready") return null;
  const { mics, cameras, speakers } = media.devices;

  return (
    <div className={`grid gap-2.5 ${className}`}>
      <DevicePicker
        label="Microphone"
        icon={<Mic className="h-3.5 w-3.5" />}
        options={mics}
        value={selectedDevice(mics, media.micId)}
        onChange={media.setMic}
        disabled={media.switching}
      />
      <DevicePicker
        label="Camera"
        icon={<Video className="h-3.5 w-3.5" />}
        options={cameras}
        value={selectedDevice(cameras, media.cameraId)}
        onChange={media.setCamera}
        disabled={media.switching}
      />
      {speakerSupported && speakers.length > 0 && (
        <DevicePicker
          label="Speaker"
          icon={<Volume2 className="h-3.5 w-3.5" />}
          options={speakers}
          value={selectedDevice(speakers, speakerId || "default")}
          onChange={setSpeakerId}
        />
      )}
      {media.deviceError && (
        <p role="status" className="text-xs text-amber-600 dark:text-amber-400">
          {media.deviceError}
        </p>
      )}
    </div>
  );
}

function DevicePicker({
  label,
  icon,
  options,
  value,
  onChange,
  disabled = false,
}: {
  label: string;
  icon: React.ReactNode;
  options: DeviceOption[];
  value: string;
  onChange: (deviceId: string) => void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="grid grid-cols-[6.5rem_1fr] items-center gap-2">
      <label
        htmlFor={id}
        className="inline-flex items-center gap-1.5 text-xs font-medium text-ink-soft"
      >
        {icon}
        {label}
      </label>
      <select
        id={id}
        value={value}
        disabled={disabled || options.length === 0}
        onChange={(e) => onChange(e.target.value)}
        className="h-9 w-full min-w-0 truncate rounded-md border border-line bg-paper px-2.5 text-sm text-ink focus:border-phosphor focus:outline-none focus:ring-2 focus:ring-phosphor/30 disabled:opacity-60"
      >
        {options.length === 0 ? (
          <option value="">None found</option>
        ) : (
          options.map((o) => (
            <option key={o.deviceId} value={o.deviceId}>
              {o.label}
            </option>
          ))
        )}
      </select>
    </div>
  );
}
