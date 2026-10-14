"use client";
import { useEffect, useState, type ReactNode } from "react";
import { AlertTriangle, CircleDot, Headphones } from "lucide-react";
import { LocalTime } from "@/components/ui/local-time";
import { greenRoomCta } from "../logic";
import type { LocalMediaView, RoomKind } from "../types";
import { RoomButton, Spinner } from "../ui";
import { DeviceControls } from "./device-controls";
import { SelfPreview } from "./self-preview";

/**
 * Before joining: camera preview, mic meter, device pickers and tests, then
 * one button. Webinar viewers (who never send media) get the speaker check
 * only.
 */
export function GreenRoom({
  kind,
  title,
  name,
  media,
  hosting,
  primary = false,
  recordingNotice,
  joining,
  error,
  rehearsalUntil = null,
  onJoin,
}: {
  kind: RoomKind;
  title: string;
  name: string;
  /** Null: this person never sends media (webinar viewer). */
  media: LocalMediaView | null;
  hosting: readonly string[] | null | undefined;
  /** This host still holds the main-stage seat: "Rejoin as host". */
  primary?: boolean;
  recordingNotice: ReactNode | null | undefined;
  joining: boolean;
  error: string | null | undefined;
  /** Webinar hosts before the go-live window (ISO): a rehearsal, students join from then. */
  rehearsalUntil?: string | null;
  onJoin: () => void;
}) {
  const cta = greenRoomCta({ kind, broadcaster: !!media, hosting, rehearsal: !!rehearsalUntil, primary });
  // A click before hydration would be lost: the button waits for it.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  const waitingForPermission = media?.status === "requesting" || media?.status === "idle";

  const join = (
    <div className="space-y-2">
      <RoomButton
        variant="primary"
        size="lg"
        className="w-full"
        onClick={onJoin}
        busy={joining}
        disabled={joining || !hydrated}
        data-testid="green-room-join"
      >
        {joining ? "Connecting…" : cta.label}
      </RoomButton>
      {cta.detail ? (
        <p className="text-center text-sm text-[#a1a1aa]" data-testid="green-room-hosting">
          {cta.detail}
        </p>
      ) : null}
      {cta.cohost ? (
        <p className="text-center text-xs text-[#71717a]">You join with camera and mic off.</p>
      ) : null}
      {rehearsalUntil ? (
        <p className="text-center text-sm text-[#a1a1aa]" data-testid="green-room-rehearsal">
          Not live yet: students can join from <LocalTime value={rehearsalUntil} mode="time" />.
        </p>
      ) : null}
      {error ? (
        <p className="text-center text-sm text-[#ff8a8d]" role="alert" data-testid="green-room-error">
          {error}
        </p>
      ) : null}
    </div>
  );

  const notice = recordingNotice ? (
    <div
      className="flex items-start gap-2 rounded-md border border-[#5c2a2c] bg-[#2a1416] px-3 py-2.5 text-sm text-[#ffd1d2]"
      data-testid="recording-notice"
    >
      <CircleDot className="mt-0.5 h-4 w-4 shrink-0 text-[#e5484d]" aria-hidden />
      <div className="min-w-0">{recordingNotice}</div>
    </div>
  ) : null;

  return (
    <div className="h-full overflow-y-auto" data-testid="green-room" data-cta={cta.label}>
      <div className="mx-auto grid w-full max-w-5xl gap-6 px-4 py-6 sm:px-6 md:grid-cols-[minmax(0,1fr)_320px] md:items-start md:py-10">
        <div className="min-w-0 space-y-3">
          {media ? (
            <>
              <SelfPreview media={media} name={name} />
              <PermissionLine media={media} />
            </>
          ) : (
            <div className="grid aspect-video w-full place-items-center rounded-md bg-[#1b1b1f] px-6 text-center">
              <div>
                <Headphones className="mx-auto h-8 w-8 text-[#a1a1aa]" aria-hidden />
                <p className="mt-3 text-sm text-[#f4f4f5]">You&rsquo;re watching.</p>
                <p className="mt-1 text-sm text-[#a1a1aa]">Your camera and mic stay off.</p>
              </div>
            </div>
          )}
        </div>

        <div className="min-w-0 space-y-5">
          <div>
            <h1 className="text-lg font-medium text-[#f4f4f5]">{title}</h1>
            <p className="mt-1 text-sm text-[#a1a1aa]">
              {waitingForPermission ? (
                <span className="inline-flex items-center gap-2">
                  <Spinner className="h-3.5 w-3.5" /> Allow camera and mic in your browser.
                </span>
              ) : (
                "Check your audio, then join."
              )}
            </p>
          </div>
          {notice}
          {join}
          <div className="border-t border-[#26262b] pt-4">
            <DeviceControls media={media} />
          </div>
        </div>
      </div>
    </div>
  );
}

function PermissionLine({ media }: { media: LocalMediaView }) {
  let message: string | null = null;
  let retry = false;
  switch (media.status) {
    case "denied":
      message = "Camera and mic are blocked. Allow them from the address bar, then try again.";
      retry = true;
      break;
    case "missing":
      message = "No camera or mic found. You can still join to watch and listen.";
      break;
    case "unsupported":
      message = "This browser can't use a camera or mic here. Try Chrome, Edge or Safari.";
      break;
    case "error":
      message = media.error ?? "Couldn't start your camera or mic.";
      retry = true;
      break;
    default:
      if (media.cameraStatus && media.cameraStatus !== "ready" && media.cameraStatus !== "off") {
        message = "Camera unavailable. You'll join with your mic only.";
      } else if (media.micStatus && media.micStatus !== "ready" && media.micStatus !== "off") {
        message = "Mic unavailable. Others won't hear you.";
      }
  }
  if (!message) return null;
  return (
    <div
      className="flex items-start gap-2 rounded-md border border-[#4a3a12] bg-[#241d0c] px-3 py-2.5 text-sm text-[#ffe3a3]"
      role="alert"
      data-testid="permission-line"
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[#ffb224]" aria-hidden />
      <span className="min-w-0 flex-1">{message}</span>
      {retry ? (
        <button
          type="button"
          onClick={media.start}
          className="shrink-0 text-sm font-semibold text-[#FFBB00] hover:underline"
        >
          Try again
        </button>
      ) : null}
    </div>
  );
}
