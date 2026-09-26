"use client";
import { Button } from "@/components/ui/button";
import { VideoTile } from "@/components/live/video-tile";
import { CallControls, MicMeter } from "@/components/live/call-controls";
import { useLocalMedia } from "@/components/live/use-local-media";
import type { LiveRole } from "@/lib/live";
import { AlertTriangle, Radio, Loader2 } from "lucide-react";

/**
 * The green room.
 *
 * Everyone passes through this before entering a room, host and viewer alike.
 * It exists to move the two failures that ruin the first minute of a call —
 * blocked permissions and a dead microphone — to *before* anyone is watching.
 *
 * A webinar viewer still sees it, minus the camera: they get the "you're
 * joining as a viewer" expectation instead, which is the other thing worth
 * settling before the door opens.
 */
export function PreJoin({
  title,
  subtitle,
  role,
  onJoin,
  joinLabel = "Join now",
  busy = false,
  notice,
}: {
  title: string;
  subtitle?: string;
  /**
   * Something the person must see BEFORE the Join button — a 1:1's recording
   * notice. Rendered above the button, never below it, so joining is the act
   * of having read it.
   */
  notice?: React.ReactNode;
  role: LiveRole;
  onJoin: (opts: { cameraOn: boolean; micOn: boolean }) => void;
  joinLabel?: string;
  busy?: boolean;
}) {
  const canBroadcast = role === "host";
  const media = useLocalMedia({ autoStart: canBroadcast });

  const blocked =
    media.status === "denied" ||
    media.status === "missing" ||
    media.status === "unsupported" ||
    media.status === "error";

  return (
    <div className="mx-auto max-w-4xl">
      <div className="grid gap-6 md:grid-cols-[1.3fr_1fr] md:items-start">
        <div>
          {canBroadcast ? (
            <>
              <VideoTile
                stream={media.stream}
                name="You"
                label="host"
                cameraOn={media.cameraOn}
                micOn={media.micOn}
                mirrored
                muted
              />
              {media.status === "requesting" && (
                <p className="mt-3 inline-flex items-center gap-2 text-xs text-ink-faint">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Waiting for camera and microphone permission…
                </p>
              )}
              {media.status === "ready" && (
                <div className="mt-3 flex items-center gap-3">
                  <MicMeter level={media.level} muted={!media.micOn} />
                  <span className="text-xs text-ink-faint">
                    {media.micOn ? "Say something to test your mic" : "Muted"}
                  </span>
                </div>
              )}
            </>
          ) : (
            <div className="grid aspect-video place-items-center rounded-xl border border-line bg-wash">
              <div className="px-6 text-center">
                <Radio className="mx-auto h-7 w-7 text-phosphor-ink" />
                <p className="mt-3 text-sm font-medium text-ink">
                  You&rsquo;re joining as a viewer
                </p>
                {/*
                  Deliberately does not promise chat. In a webinar the viewer
                  is a hidden participant, which in Daily means they can read
                  chat but not send it — so the Q&A panel is their channel, and
                  the caller passes the copy that says so. This is the generic
                  fallback for a viewer with no Q&A alongside.
                */}
                <p className="mt-1 text-xs text-ink-soft">
                  Your camera and microphone stay off, and nobody can see who
                  else is watching.
                </p>
              </div>
            </div>
          )}
        </div>

        <div>
          <h1 className="font-display text-2xl font-semibold tracking-[-0.02em] text-ink">
            {title}
          </h1>
          {subtitle && <p className="mt-1 text-sm text-ink-soft">{subtitle}</p>}

          {notice}

          {blocked && (
            <div className="mt-4 flex gap-2.5 rounded-xl border border-amber-500/40 bg-amber-400/10 p-3">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
              <div className="text-xs">
                <p className="font-medium text-ink">{media.error}</p>
                {media.status === "denied" && (
                  <button
                    onClick={media.start}
                    className="mt-1.5 text-phosphor-ink underline underline-offset-2"
                  >
                    Try again
                  </button>
                )}
                <p className="mt-1.5 text-ink-soft">
                  You can still join — you&rsquo;ll be able to watch and listen.
                </p>
              </div>
            </div>
          )}

          {canBroadcast && media.status === "ready" && (
            <div className="mt-4">
              <CallControls
                micOn={media.micOn}
                cameraOn={media.cameraOn}
                onToggleMic={media.toggleMic}
                onToggleCamera={media.toggleCamera}
                onLeave={() => history.back()}
                canBroadcast
              />
            </div>
          )}

          <Button
            size="lg"
            className="mt-4 w-full"
            disabled={busy}
            onClick={() =>
              onJoin({ cameraOn: media.cameraOn, micOn: media.micOn })
            }
          >
            {busy ? "Connecting…" : joinLabel}
          </Button>

          <p className="mt-3 text-center text-[11px] text-ink-faint">
            Works best in Chrome, Edge, or Safari. Camera and microphone need a
            secure connection.
          </p>
        </div>
      </div>
    </div>
  );
}
