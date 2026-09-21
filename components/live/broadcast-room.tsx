"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { PreJoin } from "@/components/live/pre-join";
import { LiveDot } from "@/components/live/call-stage";
import { VideoTile } from "@/components/live/video-tile";
import { CallControls } from "@/components/live/call-controls";
import { QAPanel } from "@/components/live/qa-panel";
import { useLocalMedia } from "@/components/live/use-local-media";
import { useLiveSession } from "@/components/live/use-live-session";
import { Button, ButtonLink } from "@/components/ui/button";
import { headcountLabel, type LiveRole, type WebinarQuestion } from "@/lib/live";
import type { LiveCredentials, LivePeer } from "@/lib/live-rooms";
import { AlertTriangle, Users, Loader2 } from "lucide-react";

/**
 * A batch0 Live room — the built-in provider's equivalent of LiveRoom.
 *
 * Same two halves as the Daily version: the green room and the chrome are
 * ours, and the call itself fills the middle. The difference is that the
 * middle is now ours too — `useLiveSession` holds the peer connections, and
 * what lands here is a set of `MediaStream`s to render, which is exactly what
 * `VideoTile` has taken since it was written.
 *
 * The host/viewer split shows up three times, and all three read from `role`
 * rather than from anything the browser could be talked into changing:
 *
 *   - a viewer is given no camera and no mic, and the engine builds its
 *     connection recvonly, so there is nothing to un-mute;
 *   - a viewer sees the host and no one else, because the server never told
 *     it anyone else exists;
 *   - only the host sees the real headcount.
 *
 * The one deliberate exception to that last rule is an admin-announced
 * `displayViewerCount`, which is shown to everyone. `headcountLabel` owns the
 * precedence so this room and the Daily one cannot disagree about it.
 */

type Phase = "prejoin" | "live" | "left";

export function BroadcastRoom({
  kind,
  roomId,
  title,
  role,
  backHref,
  displayViewerCount = null,
  qa,
  join,
  announce,
  leave,
  listPeers,
}: {
  kind: "event" | "call";
  roomId: string;
  title: string;
  role: LiveRole;
  backHref: string;
  /**
   * Admin-announced headcount (events.display_viewer_count). When set it is
   * shown to everyone in place of the hidden roster — the deliberate
   * exception to audience privacy. Null keeps the default: the host sees the
   * real count, a viewer sees nothing.
   */
  displayViewerCount?: number | null;
  /** Present for webinars, absent for 1:1 calls. */
  qa?: { eventId: string; initialQuestions: WebinarQuestion[] };
  join: () => Promise<LiveCredentials | null>;
  announce: () => Promise<boolean>;
  leave: () => Promise<void>;
  listPeers: () => Promise<LivePeer[]>;
}) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("prejoin");
  const isHost = role === "host";

  // What they chose in the green room, applied once the real stream exists.
  const wanted = useRef<{ cameraOn: boolean; micOn: boolean }>({
    cameraOn: true,
    micOn: true,
  });
  const applied = useRef(false);

  // The call's own devices, acquired after the green room rather than handed
  // over from it: PreJoin releases its stream on unmount, and re-acquiring
  // costs no second permission prompt now that permission is granted.
  const media = useLocalMedia({ autoStart: isHost && phase === "live" });
  const screen = useScreenShare();

  // Honour the green room's toggles once, as soon as there is a stream to
  // apply them to. Joining with the camera off must not flash a face first.
  useEffect(() => {
    if (applied.current || media.status !== "ready") return;
    applied.current = true;
    if (!wanted.current.cameraOn && media.cameraOn) media.toggleCamera();
    if (!wanted.current.micOn && media.micOn) media.toggleMic();
  }, [media]);

  const session = useLiveSession({
    kind,
    roomId,
    role: isHost ? "host" : "viewer",
    enabled: phase === "live",
    localStream: isHost ? media.stream : null,
    screenStream: screen.stream,
    // Passed through rather than inferred from `track.enabled`: a disabled
    // track still transmits black frames and silence, which reaches a viewer
    // as a frozen picture. The engine detaches instead, so the remote tile
    // can honestly say "camera off".
    cameraOn: media.cameraOn,
    micOn: media.micOn,
    join,
    announce,
    leave,
    listPeers,
  });

  // Unlike Daily, this provider knows its own roster, so `realCount` is a
  // real number for a host rather than null — the default "host sees the
  // truth, viewer sees nothing" comes out of `headcountLabel` directly.
  const headcount = headcountLabel({
    role,
    displayCount: displayViewerCount,
    realCount: session.audienceCount,
  });

  const onJoin = useCallback((opts: { cameraOn: boolean; micOn: boolean }) => {
    wanted.current = opts;
    setPhase("live");
  }, []);

  const hangUp = useCallback(() => {
    screen.stop();
    media.stop();
    setPhase("left");
  }, [media, screen]);

  if (phase === "left") {
    return (
      <Centered title="You've left">
        <div className="flex flex-wrap justify-center gap-2">
          <Button onClick={() => router.refresh()}>Rejoin</Button>
          <ButtonLink variant="secondary" href={backHref}>
            Back
          </ButtonLink>
        </div>
      </Centered>
    );
  }

  if (phase === "prejoin") {
    return (
      <PreJoin
        title={title}
        subtitle={
          isHost
            ? "You're the host — your camera and mic will be live."
            : qa
              ? "Your camera and mic stay off, and nobody can see who else is here. You can ask questions beside the video."
              : "You'll be able to watch and listen."
        }
        role={role}
        onJoin={onJoin}
        joinLabel={isHost ? "Start" : "Join"}
      />
    );
  }

  // The one broadcaster a viewer is watching. A host watching another host
  // (two staff, or a 1:1) gets the same tile.
  const speaker = session.remotes[0] ?? null;
  const remoteScreen = speaker?.streams.screen ?? null;
  const remoteCamera = speaker?.streams.camera ?? null;
  const remoteAudio = speaker?.streams.audio ?? null;

  return (
    <div className={qa ? "mx-auto max-w-6xl" : "mx-auto max-w-5xl"}>
      <header className="mb-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <h1 className="truncate font-display text-lg font-semibold tracking-[-0.02em] text-ink">
            {title}
          </h1>
          {session.state === "live" && <LiveDot />}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {/*
            By default the headcount is host-only and has no viewer
            equivalent — `audienceCount` is null for a viewer, so there is no
            number here to hide. A student must not be able to tell whether
            they are one of three or one of thirty.

            An announced count overrides that for everyone, which is the point
            of the field. The host is not lied to: when the figure is
            announced, the real roster is shown beside it.
          */}
          {headcount && (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-line px-2.5 py-0.5 text-xs text-ink-faint">
              <Users className="h-3.5 w-3.5" />
              {headcount.count.toLocaleString()} watching
              {headcount.announced && isHost && session.audienceCount !== null && (
                <span className="text-ink-faint/70">
                  · {session.audienceCount} really here
                </span>
              )}
            </span>
          )}
          <span
            className={`rounded-full border px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-wider ${
              isHost
                ? "border-phosphor/50 bg-phosphor/10 text-phosphor-ink"
                : "border-line text-ink-faint"
            }`}
          >
            {isHost ? "Hosting" : "Watching"}
          </span>
        </div>
      </header>

      {session.error && (
        <div className="mb-3 flex items-start gap-2.5 rounded-xl border border-amber-500/40 bg-amber-400/10 p-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
          <p className="text-xs text-ink-soft">{session.error}</p>
        </div>
      )}

      <div className="flex flex-col gap-3 lg:flex-row">
        <div className="min-w-0 flex-1 space-y-3">
          {isHost ? (
            <>
              {/* Presenting replaces the big frame; the camera drops to a
                  corner tile, which is what a viewer sees too. */}
              {screen.stream ? (
                <>
                  <VideoTile
                    stream={screen.stream}
                    name="Your screen"
                    label="presenting"
                    muted
                    className="w-full"
                  />
                  <div className="w-48">
                    <VideoTile
                      stream={media.stream}
                      name="You"
                      label="host"
                      cameraOn={media.cameraOn}
                      micOn={media.micOn}
                      mirrored
                      muted
                    />
                  </div>
                </>
              ) : (
                <VideoTile
                  stream={media.stream}
                  name="You"
                  label="host"
                  cameraOn={media.cameraOn}
                  micOn={media.micOn}
                  mirrored
                  muted
                  className="w-full"
                />
              )}

              {/* Other broadcasters — a co-host, or the other party in a 1:1.
                  Never the audience. */}
              {session.remotes.length > 0 && (
                <div className="grid gap-3 sm:grid-cols-2">
                  {session.remotes.map((p) => (
                    <RemoteTile key={p.peerId} peer={p} />
                  ))}
                </div>
              )}
            </>
          ) : (
            <ViewerStage
              name={speaker?.name ?? "Host"}
              connected={!!speaker && speaker.state === "live"}
              screen={remoteScreen}
              camera={remoteCamera}
              audio={remoteAudio}
            />
          )}
        </div>

        {qa && (
          <div className="h-[50vh] min-h-[320px] w-full shrink-0 lg:h-[70vh] lg:w-80">
            <QAPanel
              eventId={qa.eventId}
              role={role}
              initialQuestions={qa.initialQuestions}
            />
          </div>
        )}
      </div>

      <div className="mt-3">
        <CallControls
          micOn={media.micOn}
          cameraOn={media.cameraOn}
          onToggleMic={media.toggleMic}
          onToggleCamera={media.toggleCamera}
          onToggleScreen={isHost ? screen.toggle : undefined}
          screenSharing={!!screen.stream}
          onLeave={hangUp}
          canBroadcast={isHost}
        />
      </div>
    </div>
  );
}

/**
 * What a student sees: the host, large, and nothing else.
 *
 * Audio is rendered through a separate hidden `<audio>` rather than relying on
 * whichever video element happens to carry it. The host's audio arrives on its
 * own transceiver (slot `audio`), and when the host switches to slides the
 * video element being shown changes — if sound rode along with a particular
 * video tag, presenting would silence the webinar.
 */
function ViewerStage({
  name,
  connected,
  screen,
  camera,
  audio,
}: {
  name: string;
  connected: boolean;
  screen: MediaStream | null;
  camera: MediaStream | null;
  audio: MediaStream | null;
}) {
  // Both the connection AND real media are required before the placeholder
  // goes away. `camera`/`screen` are now only non-null once a track is
  // actually unmuted, so this no longer clears the instant an offer is
  // applied — which used to drop students onto a black rectangle seconds
  // before, or entirely without, any video arriving.
  if (!camera && !screen) {
    return (
      <>
        {/*
          Audio is mounted here too, not only in the branch below. A host
          talking with their camera off is a normal thing to do, and returning
          early without this would silence the webinar the moment they did it.
        */}
        <AudioSink stream={audio} />
        <div className="grid aspect-video w-full place-items-center rounded-xl border border-line bg-ink-900">
          <div className="px-6 text-center">
            <Loader2 className="mx-auto h-6 w-6 animate-spin text-ink-faint" />
            <p className="mt-3 text-sm font-medium text-[#fff]">
              {connected
                ? "The host's camera is off"
                : "Waiting for the host to start"}
            </p>
            <p className="mt-1 text-xs text-[#fff]/60">
              {connected
                ? "You'll hear them, and see them as soon as they turn it on."
                : "You'll join automatically — no need to refresh."}
            </p>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <AudioSink stream={audio} />
      {screen ? (
        <>
          <VideoTile stream={screen} name={name} label="presenting" muted className="w-full" />
          {camera && (
            <div className="mt-3 w-48">
              <VideoTile stream={camera} name={name} muted />
            </div>
          )}
        </>
      ) : (
        <VideoTile stream={camera} name={name} label="host" muted className="w-full" />
      )}
    </>
  );
}

/** Remote audio, decoupled from whichever video tile is on screen. */
function AudioSink({ stream }: { stream: MediaStream | null }) {
  const ref = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (el.srcObject !== (stream ?? null)) el.srcObject = stream ?? null;
    // Autoplay can still be refused before any interaction; nothing useful to
    // do beyond not throwing. Joining is a click, so in practice it plays.
    if (stream) el.play?.().catch(() => {});
  }, [stream]);
  return <audio ref={ref} autoPlay playsInline className="hidden" />;
}

function RemoteTile({
  peer,
}: {
  peer: { name: string; streams: { camera?: MediaStream; screen?: MediaStream; audio?: MediaStream } };
}) {
  // `screen` is only ever present while the peer is genuinely presenting —
  // the engine drops a slot whose track is muted, so this no longer picks an
  // empty screen transceiver over a live camera.
  const screen = peer.streams.screen ?? null;
  const camera = peer.streams.camera ?? null;
  return (
    <>
      <AudioSink stream={peer.streams.audio ?? null} />
      <VideoTile
        stream={screen ?? camera}
        name={peer.name}
        label={screen ? "presenting" : undefined}
        cameraOn={!!(screen ?? camera)}
        micOn={!!peer.streams.audio}
        muted
      />
    </>
  );
}

/**
 * Screen sharing.
 *
 * Kept out of `useLocalMedia` because it is a different permission with a
 * different lifecycle: the browser puts its own "Stop sharing" bar on screen,
 * and a share that ends there must be reflected here or the host keeps seeing
 * a control that claims they are still presenting.
 */
function useScreenShare() {
  const [stream, setStream] = useState<MediaStream | null>(null);

  const stop = useCallback(() => {
    setStream((s) => {
      s?.getTracks().forEach((t) => t.stop());
      return null;
    });
  }, []);

  const start = useCallback(async () => {
    const md = navigator.mediaDevices as MediaDevices & {
      getDisplayMedia?: (c: DisplayMediaStreamOptions) => Promise<MediaStream>;
    };
    if (!md?.getDisplayMedia) return;
    try {
      const s = await md.getDisplayMedia({ video: true, audio: false });
      // The browser's own stop button ends the track, not our state.
      s.getVideoTracks()[0]?.addEventListener("ended", () => setStream(null));
      setStream(s);
    } catch {
      // Cancelling the picker is a normal outcome, not an error worth showing.
    }
  }, []);

  const toggle = useCallback(() => {
    if (stream) stop();
    else void start();
  }, [start, stop, stream]);

  useEffect(() => () => stream?.getTracks().forEach((t) => t.stop()), [stream]);

  return { stream, toggle, stop };
}

function Centered({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mx-auto max-w-2xl py-16 text-center">
      <h1 className="font-display text-2xl font-semibold tracking-[-0.02em] text-ink">
        {title}
      </h1>
      <div className="mt-5">{children}</div>
    </div>
  );
}
