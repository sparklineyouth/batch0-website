"use client";
import { useEffect, useRef } from "react";
import { Mic, MicOff, Video, VideoOff } from "lucide-react";
import type { LocalMediaView } from "../types";
import { FOCUS, initials } from "../ui";

/** Mirrored self view with mic/camera toggles on it (green room, settings). */
export function SelfPreview({
  media,
  name,
  className = "",
  toggles = true,
}: {
  media: LocalMediaView;
  name: string;
  className?: string;
  toggles?: boolean;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const stream = media.stream;
  const hasVideo = !!stream?.getVideoTracks().length;
  const showVideo = hasVideo && media.cameraOn;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (el.srcObject !== stream) el.srcObject = stream;
    if (stream) el.play?.().catch(() => {});
  }, [stream]);

  return (
    <div
      className={`relative aspect-video w-full overflow-hidden rounded-md bg-[#1b1b1f] ${className}`}
      data-testid="self-preview"
    >
      <video
        ref={ref}
        muted
        autoPlay
        playsInline
        className={`absolute inset-0 h-full w-full -scale-x-100 object-cover ${showVideo ? "" : "invisible"}`}
      />
      {!showVideo && (
        <div className="absolute inset-0 grid place-items-center">
          <div className="grid h-20 w-20 place-items-center rounded-full bg-[#34343a] text-2xl font-medium text-[#f4f4f5]">
            {initials(name)}
          </div>
        </div>
      )}
      {toggles ? (
        <div className="absolute inset-x-0 bottom-3 flex justify-center gap-3">
          <ToggleButton
            on={media.micOn}
            onClick={media.toggleMic}
            labelOn="Turn microphone off"
            labelOff="Turn microphone on"
            iconOn={<Mic className="h-5 w-5" />}
            iconOff={<MicOff className="h-5 w-5" />}
            testId="preview-mic"
          />
          <ToggleButton
            on={media.cameraOn}
            onClick={media.toggleCamera}
            labelOn="Turn camera off"
            labelOff="Turn camera on"
            iconOn={<Video className="h-5 w-5" />}
            iconOff={<VideoOff className="h-5 w-5" />}
            testId="preview-camera"
          />
        </div>
      ) : null}
    </div>
  );
}

function ToggleButton({
  on,
  onClick,
  labelOn,
  labelOff,
  iconOn,
  iconOff,
  testId,
}: {
  on: boolean;
  onClick: () => void;
  labelOn: string;
  labelOff: string;
  iconOn: React.ReactNode;
  iconOff: React.ReactNode;
  testId: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={on ? labelOn : labelOff}
      aria-pressed={!on}
      title={on ? labelOn : labelOff}
      data-testid={testId}
      data-on={on}
      className={`grid h-11 w-11 place-items-center rounded-md transition-colors ${FOCUS} ${
        on
          ? "bg-[rgba(38,38,43,0.85)] text-[#fff] hover:bg-[rgba(50,50,56,0.95)]"
          : "bg-[#e5484d] text-[#fff] hover:bg-[#ec5d62]"
      }`}
    >
      {on ? iconOn : iconOff}
    </button>
  );
}
