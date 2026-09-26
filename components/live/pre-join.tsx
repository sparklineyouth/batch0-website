"use client";
import { useRouter } from "next/navigation";
import { Button, ButtonLink } from "@/components/ui/button";
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
 *
 * The way out goes to `backHref`, always visible — including when the camera
 * is blocked or missing, which is exactly when someone most wants to leave.
 * It used to be `history.back()`, which does nothing in a tab opened from a
 * calendar invite or an email, and was only rendered once media was ready.
 */
export function PreJoin({
  title,
  subtitle,
  notice,
  role,
  onJoin,
  joinLabel = "Join now",
  hideJoin = false,
  busy = false,
  joinError = null,
  autoStartMedia,
  selfLabel = "host",
  backHref,
}: {
  title: string;
  subtitle?: string;
  /** A line above everything else — e.g. "This webinar was ended at 19:40." */
  notice?: React.ReactNode;
  role: LiveRole;
  onJoin: (opts: { cameraOn: boolean; micOn: boolean }) => void | Promise<void>;
  joinLabel?: string;
  /** No way in from here at all (an ended webinar for someone who can't reopen it). */
  hideJoin?: boolean;
  busy?: boolean;
  /** Why the last press of the join button failed, if it did. */
  joinError?: string | null;
  /**
   * Start the camera on arrival. Defaults to on for a broadcaster; the room
   * turns it off where lighting the camera would be premature — a host
   * arriving after End, who has not yet chosen to reopen.
   */
  autoStartMedia?: boolean;
  /** The badge on the self-view. Null for none (a 1:1 has no "host"). */
  selfLabel?: string | null;
  /** Where Back goes. Without it (the dev preview), history is the fallback. */
  backHref?: string;
}) {
  const router = useRouter();
  const canBroadcast = role === "host";
  const media = useLocalMedia({ autoStart: autoStartMedia ?? canBroadcast });
  const goBack = () => {
    if (backHref) router.push(backHref);
    else history.back();
  };

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
                label={selfLabel ?? undefined}
                cameraOn={media.cameraOn}
                micOn={media.micOn}
                mirrored
                muted
              />
              {autoStartMedia === false && media.status === "idle" && !hideJoin && (
                <button
                  type="button"
                  onClick={media.start}
                  className="mt-3 text-xs text-phosphor-ink underline underline-offset-2"
                >
                  Check your camera and mic
                </button>
              )}
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
          {notice && (
            <p className="mb-2 inline-flex rounded-full border border-line px-2.5 py-0.5 text-xs text-ink-soft">
              {notice}
            </p>
          )}
          <h1 className="font-display text-2xl font-semibold tracking-[-0.02em] text-ink">
            {title}
          </h1>
          {subtitle && <p className="mt-1 text-sm text-ink-soft">{subtitle}</p>}

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
                {!hideJoin && (
                  <p className="mt-1.5 text-ink-soft">
                    You can still join — you&rsquo;ll be able to watch and
                    listen.
                  </p>
                )}
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
                onLeave={goBack}
                canBroadcast
              />
            </div>
          )}

          {!hideJoin && (
            <Button
              size="lg"
              className="mt-4 w-full"
              // Not while the permission prompt is still up: joining then
              // unmounts this screen with a getUserMedia in flight, which is
              // how a camera used to be left running with nobody to stop it.
              disabled={busy || (canBroadcast && media.status === "requesting")}
              onClick={() =>
                void onJoin({ cameraOn: media.cameraOn, micOn: media.micOn })
              }
            >
              {busy
                ? "Connecting…"
                : canBroadcast && media.status === "requesting"
                  ? "Waiting for camera…"
                  : joinLabel}
            </Button>
          )}

          {joinError && (
            <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">
              {joinError}
            </p>
          )}

          {backHref ? (
            <ButtonLink
              variant="ghost"
              size="sm"
              href={backHref}
              className="mt-2 w-full"
            >
              Back
            </ButtonLink>
          ) : null}

          <p className="mt-3 text-center text-[11px] text-ink-faint">
            Works best in Chrome, Edge, or Safari. Camera and microphone need a
            secure connection.
          </p>
        </div>
      </div>
    </div>
  );
}
