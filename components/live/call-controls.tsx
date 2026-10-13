"use client";
import {
  Mic,
  MicOff,
  Video,
  VideoOff,
  MonitorUp,
  PhoneOff,
  Users,
  MessageSquare,
  Circle,
  Settings2,
} from "lucide-react";

/**
 * The control bar under a call.
 *
 * Pure presentation — every button is a callback. When the provider lands,
 * these callbacks point at its participant API instead of local tracks, and
 * nothing here changes.
 */
export function CallControls({
  micOn,
  cameraOn,
  onToggleMic,
  onToggleCamera,
  onLeave,
  onToggleScreen,
  screenSharing = false,
  onToggleParticipants,
  onToggleChat,
  onToggleRecording,
  recording = false,
  /** Viewers in a webinar have no camera or mic to control. */
  canBroadcast = true,
  participantCount,
  onToggleDevices,
  devicesOpen = false,
}: {
  micOn: boolean;
  cameraOn: boolean;
  onToggleMic: () => void;
  onToggleCamera: () => void;
  onLeave: () => void;
  onToggleScreen?: () => void;
  screenSharing?: boolean;
  onToggleParticipants?: () => void;
  onToggleChat?: () => void;
  onToggleRecording?: () => void;
  recording?: boolean;
  canBroadcast?: boolean;
  participantCount?: number;
  /** Opens the microphone / camera / speaker pickers (DeviceSettings). */
  onToggleDevices?: () => void;
  devicesOpen?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center justify-center gap-2 rounded-2xl border border-line bg-wash px-3 py-2.5">
      {canBroadcast && (
        <>
          <ControlButton
            active={micOn}
            onClick={onToggleMic}
            label={micOn ? "Mute microphone" : "Unmute microphone"}
            danger={!micOn}
          >
            {micOn ? <Mic className="h-4 w-4" /> : <MicOff className="h-4 w-4" />}
          </ControlButton>

          <ControlButton
            active={cameraOn}
            onClick={onToggleCamera}
            label={cameraOn ? "Turn camera off" : "Turn camera on"}
            danger={!cameraOn}
          >
            {cameraOn ? (
              <Video className="h-4 w-4" />
            ) : (
              <VideoOff className="h-4 w-4" />
            )}
          </ControlButton>

          {onToggleDevices && (
            <ControlButton
              active={devicesOpen}
              onClick={onToggleDevices}
              label={devicesOpen ? "Hide device settings" : "Choose microphone, camera and speaker"}
            >
              <Settings2 className="h-4 w-4" />
            </ControlButton>
          )}

          {onToggleScreen && (
            <ControlButton
              active={screenSharing}
              onClick={onToggleScreen}
              label={screenSharing ? "Stop sharing screen" : "Share screen"}
            >
              <MonitorUp className="h-4 w-4" />
            </ControlButton>
          )}

          {onToggleRecording && (
            <ControlButton
              active={recording}
              onClick={onToggleRecording}
              label={recording ? "Stop recording" : "Start recording"}
            >
              <Circle
                className={`h-4 w-4 ${recording ? "fill-red-500 text-red-500" : ""}`}
              />
            </ControlButton>
          )}

          <span className="mx-1 h-6 w-px bg-line" aria-hidden />
        </>
      )}

      {onToggleParticipants && (
        <ControlButton onClick={onToggleParticipants} label="Show participants">
          <Users className="h-4 w-4" />
          {typeof participantCount === "number" && (
            <span className="text-xs tabular-nums">{participantCount}</span>
          )}
        </ControlButton>
      )}

      {onToggleChat && (
        <ControlButton onClick={onToggleChat} label="Show chat">
          <MessageSquare className="h-4 w-4" />
        </ControlButton>
      )}

      <button
        type="button"
        onClick={onLeave}
        className="ml-1 inline-flex h-10 select-none items-center justify-center gap-2 whitespace-nowrap rounded-md bg-red-500 px-4 text-sm font-semibold leading-none text-[#fff] transition-colors hover:bg-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-phosphor focus-visible:ring-offset-2 focus-visible:ring-offset-paper active:scale-[0.98]"
      >
        <PhoneOff className="h-4 w-4" />
        Leave
      </button>
    </div>
  );
}

function ControlButton({
  children,
  onClick,
  label,
  active,
  danger,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  label: string;
  active?: boolean;
  danger?: boolean;
}) {
  const tone = danger
    ? "border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400"
    : active
      ? "border-phosphor/50 bg-phosphor/15 text-phosphor-ink"
      : "border-line bg-paper text-ink-soft hover:border-ink/30 hover:text-ink";
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={active}
      title={label}
      className={`inline-flex h-10 min-w-10 select-none items-center justify-center gap-1.5 rounded-md border px-3 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-phosphor focus-visible:ring-offset-2 focus-visible:ring-offset-paper active:scale-[0.98] ${tone}`}
    >
      {children}
    </button>
  );
}

/**
 * Live microphone level. Confirms the mic is picking the person up — the
 * single most useful thing on a pre-join screen, because "I can't hear you"
 * is always discovered too late.
 */
export function MicMeter({ level, muted }: { level: number; muted?: boolean }) {
  const bars = 12;
  const lit = muted ? 0 : Math.round(level * bars);
  return (
    <div
      className="flex items-center gap-[3px]"
      role="meter"
      aria-valuenow={muted ? 0 : Math.round(level * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label="Microphone level"
    >
      {Array.from({ length: bars }, (_, i) => (
        <span
          key={i}
          className={`h-3 w-1 rounded-full transition-colors duration-75 ${
            i < lit
              ? i > bars - 3
                ? "bg-red-500"
                : "bg-phosphor"
              : "bg-line"
          }`}
        />
      ))}
    </div>
  );
}
