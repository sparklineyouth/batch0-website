"use client";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useAudioSinks, AudioSinks } from "./audio-sinks";
import { ControlBar } from "./controls";
import { DeckPresenter } from "./deck/deck-presenter";
import { DevicePanel } from "./devices/device-panel";
import { GreenRoom } from "./devices/green-room";
import { joinNames } from "./logic";
import { PopoverProvider, useCloseAllPopovers } from "./popover";
import { PresentingScreen } from "./presenting";
import { EndScreen, StageNotice, type StageNoticeKind } from "./screens";
import { RoomShell, TopBar } from "./shell";
import { PresentingThumb, Stage, type TileView } from "./stage";
import { computeStage, type StagePerson, type StageTile } from "./stage-model";
import { ToastProvider, useToasts } from "./toasts";
import type { LiveRoomProps, PanelTab, PanelUnread, RoomPeer } from "./types";
import { useRoomShortcuts } from "./use-shortcuts";
import { Spinner } from "./ui";

/**
 * The room view for webinars and 1:1 calls. Presentational: everything comes
 * in through props (see LiveRoomProps in ./types), the only state here is the
 * viewer's own UI — local pin, which panel is open, menus, toasts.
 */
export function LiveRoom(props: LiveRoomProps) {
  const [panelOpen, setPanelOpen] = useState(false);
  // Desktop webinars open the side panel at the start; phones start with the stage.
  const hasPanel = !!props.panel;
  useEffect(() => {
    if (hasPanel && window.matchMedia?.("(min-width: 1024px)").matches) setPanelOpen(true);
  }, [hasPanel]);

  const onPopoverOpen = useCallback(() => {
    if (!window.matchMedia?.("(min-width: 1024px)").matches) setPanelOpen(false);
  }, []);

  return (
    <PopoverProvider onOpen={onPopoverOpen}>
      <ToastProvider>
        {(toasts) => (
          <RoomBody {...props} toasts={toasts} panelOpen={panelOpen} setPanelOpen={setPanelOpen} />
        )}
      </ToastProvider>
    </PopoverProvider>
  );
}

function onStage(p: RoomPeer): boolean {
  return p.state === "live" || p.state === "reconnecting";
}

function hasVideo(stream: MediaStream | null | undefined): boolean {
  return !!stream && stream.getVideoTracks().length > 0;
}

/** When each remote started presenting (first seen with a screen stream). */
function usePresentingSince(remotes: readonly RoomPeer[]): ReadonlyMap<string, number> {
  const ref = useRef<Map<string, number>>(new Map());
  const ids = remotes
    .filter((r) => onStage(r) && r.streams.screen)
    .map((r) => r.peerId)
    .sort()
    .join(",");
  return useMemo(() => {
    const now = Date.now();
    const next = new Map<string, number>();
    for (const id of ids ? ids.split(",") : []) next.set(id, ref.current.get(id) ?? now);
    ref.current = next;
    return next;
  }, [ids]);
}

function RoomBody(
  props: LiveRoomProps & {
    toasts: ReactNode;
    panelOpen: boolean;
    setPanelOpen: (open: boolean | ((o: boolean) => boolean)) => void;
  },
) {
  const {
    kind,
    title,
    self,
    phase,
    backHref,
    media,
    presentation,
    remotes,
    connection,
    room,
    recording = null,
    panel = null,
    reactions = null,
    actions,
    busy = null,
    actionError = null,
    toasts,
    panelOpen,
    setPanelOpen,
  } = props;
  const toast = useToasts();
  const closePopovers = useCloseAllPopovers();

  // ── Errors → toasts ───────────────────────────────────────────────────────
  const presError = presentation?.error ?? null;
  const clearPresError = presentation?.clearError;
  useEffect(() => {
    if (presError) toast.push({ tone: "error", message: presError, onDismiss: clearPresError });
  }, [presError, clearPresError, toast]);
  const deviceError = media?.deviceError ?? null;
  useEffect(() => {
    if (deviceError && phase === "live") toast.push({ tone: "error", message: deviceError });
  }, [deviceError, phase, toast]);
  const recError = recording?.error ?? null;
  useEffect(() => {
    if (recError) toast.push({ tone: "error", message: recError });
  }, [recError, toast]);
  useEffect(() => {
    if (actionError && phase === "live") toast.push({ tone: "error", message: actionError });
  }, [actionError, phase, toast]);

  // ── Panel ─────────────────────────────────────────────────────────────────
  const [tab, setTab] = useState<PanelTab>(panel?.tabs[0] ?? "chat");
  const [unread, setUnread] = useState<PanelUnread>({ chat: 0, qa: 0, polls: 0 });
  const onUnread = useCallback((u: PanelUnread) => {
    setUnread((cur) => (cur.chat === u.chat && cur.qa === u.qa && cur.polls === u.polls ? cur : u));
  }, []);
  const togglePanel = useCallback(
    (t: PanelTab) => {
      closePopovers();
      setPanelOpen((open) => {
        if (open && t === tab) return false;
        return true;
      });
      setTab(t);
    },
    [closePopovers, setPanelOpen, tab],
  );
  const closePanel = useCallback(() => setPanelOpen(false), [setPanelOpen]);

  // ── Devices dialog ────────────────────────────────────────────────────────
  const [devicesOpen, setDevicesOpen] = useState(false);
  const openDevices = useCallback(() => {
    closePopovers();
    setDevicesOpen(true);
  }, [closePopovers]);
  const closeDevices = useCallback(() => setDevicesOpen(false), []);

  // ── Stage ─────────────────────────────────────────────────────────────────
  const [localPin, setLocalPin] = useState<string | null>(null);
  const since = usePresentingSince(remotes);
  const selfOnStage = self.broadcaster && !!media;
  const selfCamera = !!media && media.cameraOn && hasVideo(media.stream);
  const selfPresenting =
    presentation?.kind === "screen" ? "screen" : presentation?.kind === "deck" ? "deck" : null;
  const selfSince = presentation?.startedAt ?? null;

  const people = useMemo<StagePerson[]>(() => {
    const list: StagePerson[] = [];
    if (selfOnStage) {
      list.push({
        id: self.id,
        name: self.name,
        isSelf: true,
        camera: selfCamera,
        presenting: selfPresenting,
        presentingSince: selfSince,
      });
    }
    for (const r of remotes) {
      if (!onStage(r) || r.peerId === self.id) continue;
      list.push({
        id: r.peerId,
        name: r.name,
        isSelf: false,
        camera: !!r.streams.camera,
        presenting: r.streams.screen ? "screen" : null,
        presentingSince: since.get(r.peerId) ?? null,
      });
    }
    return list;
  }, [selfOnStage, self.id, self.name, selfCamera, selfPresenting, selfSince, remotes, since]);

  const primaryId = kind === "webinar" ? room.primaryId : null;
  const model = useMemo(
    () => computeStage({ kind, people, primaryId, localPin }),
    [kind, people, primaryId, localPin],
  );
  const shared = useMemo(() => computeStage({ kind, people, primaryId, localPin: null }), [kind, people, primaryId]);
  const sharedMainId = shared.main?.peerId ?? null;
  const sharedIsPresentation = shared.main?.kind === "presentation";
  const onSharedLayout = props.onSharedLayout;
  useEffect(() => {
    onSharedLayout?.({ mainId: sharedMainId, mainIsPresentation: sharedIsPresentation });
  }, [onSharedLayout, sharedMainId, sharedIsPresentation]);

  // A pin on something that went away (stopped presenting, left) is dropped.
  useEffect(() => {
    if (localPin && model.pinned === null) setLocalPin(null);
  }, [localPin, model.pinned]);

  const onPin = useCallback(
    (key: string) => {
      const next = localPin === key ? null : key;
      setLocalPin(next);
      toast.push({ tone: "info", message: next ? "Pinned for you" : "Unpinned", id: "pin" });
    },
    [localPin, toast],
  );

  const peers = useMemo(() => new Map(remotes.map((r) => [r.peerId, r])), [remotes]);
  const view = useCallback(
    (t: StageTile): TileView => {
      if (t.isSelf) {
        if (t.kind === "presentation") {
          return { stream: presentation?.stream ?? null, audio: null, showVideo: true, micOff: false, reconnecting: false, mirror: false, badge: "Presenting" };
        }
        return {
          stream: media?.stream ?? null,
          audio: media?.micOn ? media.stream : null,
          showVideo: selfCamera,
          micOff: !media?.micOn,
          reconnecting: false,
          mirror: true,
          badge: null,
        };
      }
      const p = peers.get(t.peerId);
      const reconnecting = p?.state === "reconnecting";
      if (t.kind === "presentation") {
        return { stream: p?.streams.screen ?? null, audio: null, showVideo: true, micOff: false, reconnecting, mirror: false, badge: "Presenting" };
      }
      return {
        stream: p?.streams.camera ?? null,
        audio: p?.streams.audio ?? null,
        showVideo: !!p?.streams.camera,
        micOff: !p?.streams.audio,
        reconnecting,
        mirror: false,
        badge: kind === "webinar" && t.isPrimary ? "Host" : null,
      };
    },
    [peers, media, presentation?.stream, selfCamera, kind],
  );

  // ── Notices ───────────────────────────────────────────────────────────────
  const hadHost = useRef(false);
  if (remotes.some((r) => r.state === "live")) hadHost.current = true;
  let emptyKind: StageNoticeKind = "waiting";
  if (connection.joinFailed) emptyKind = "failed";
  else if (!connection.joined) emptyKind = "connecting";
  else if (remotes.some((r) => r.state === "reconnecting" || (r.state === "connecting" && r.seenLive)))
    emptyKind = "reconnecting";
  else if (hadHost.current || room.liveStartedAt) emptyKind = "away";
  else if (props.startsAt && Date.parse(props.startsAt) > Date.now()) emptyKind = "starts";

  let waitingChip: ReactNode = null;
  if (kind === "call" && model.why === "alone" && connection.joined) {
    const away = remotes.filter((r) => !onStage(r));
    const left = away.filter((r) => r.state === "left").map((r) => r.name);
    const waiting = away.filter((r) => r.state !== "left").map((r) => r.name);
    const text = left.length
      ? `${joinNames(left)} left`
      : waiting.length
        ? `Waiting for ${joinNames(waiting)} to join`
        : "Waiting for others to join";
    waitingChip = <Chip testId="chip-waiting">{text}</Chip>;
  }

  const [hiddenError, setHiddenError] = useState<string | null>(null);
  const banner =
    connection.error && connection.error !== hiddenError ? (
      <div className="absolute inset-x-0 top-2 z-20 flex justify-center px-3" data-testid="banner-error">
        <div className="flex max-w-xl items-center gap-2 rounded-md border border-[#4a3a12] bg-[#241d0c] px-3 py-2 text-sm text-[#ffe3a3]">
          <span className="min-w-0 flex-1">{connection.error}</span>
          <button
            type="button"
            className="shrink-0 text-xs font-semibold text-[#FFBB00] hover:underline"
            onClick={() => setHiddenError(connection.error)}
          >
            Dismiss
          </button>
        </div>
      </div>
    ) : null;

  const overlay = (
    <>
      {banner}
      {connection.state === "reconnecting" && model.layout !== "empty" ? (
        <div className="pointer-events-none absolute inset-x-0 top-2 z-20 flex justify-center" data-testid="veil-reconnecting">
          <Chip>
            <Spinner className="h-3.5 w-3.5" /> Reconnecting…
          </Chip>
        </div>
      ) : null}
      {connection.joinFailed && model.layout !== "empty" ? (
        <div className="absolute inset-0 z-20 grid place-items-center rounded-md bg-[rgba(12,12,14,0.85)]">
          <StageNotice kind="failed" message={connection.joinFailed.message} onRetry={actions.retry} />
        </div>
      ) : null}
      {reactions ? (
        <div className="pointer-events-none absolute bottom-2 right-2 z-10">{reactions.overlay}</div>
      ) : null}
    </>
  );

  // ── Audio, shortcuts ──────────────────────────────────────────────────────
  const sinks = useAudioSinks();
  useEffect(() => {
    if (phase !== "live") return;
    if (sinks.blocked) {
      toast.push({
        id: "autoplay",
        tone: "info",
        message: "Your browser blocked the sound.",
        sticky: true,
        action: { label: "Enable sound", onClick: sinks.unblock },
      });
    } else toast.dismiss("autoplay");
  }, [sinks.blocked, sinks.unblock, phase, toast]);

  useRoomShortcuts(phase === "live" ? media : null);

  // ── Top bar ───────────────────────────────────────────────────────────────
  const firstLive = useRef<number | null>(null);
  if (connection.state === "live" && firstLive.current === null) firstLive.current = Date.now();
  const anyOnAir = remotes.some(onStage);
  const live =
    phase === "live" &&
    (kind === "webinar"
      ? (!!room.liveStartedAt && !room.liveEndedAt) || anyOnAir || (selfOnStage && connection.joined)
      : connection.state === "live");
  const recBy = room.recording?.byName ?? recording?.by?.name ?? null;
  const recActive = phase === "live" && (!!room.recording || recording?.state === "recording");
  const top = (
    <TopBar
      title={phase === "prejoin" ? "" : title}
      backHref={phase === "live" ? null : backHref}
      live={live}
      rec={recActive ? { by: recording?.mine ? null : recBy } : null}
      since={phase === "live" ? (kind === "webinar" ? room.liveStartedAt : firstLive.current) : null}
      audienceCount={phase === "live" ? props.audienceCount : null}
      role={phase === "live" && kind === "webinar" ? (self.broadcaster ? "Hosting" : "Watching") : null}
      connecting={phase === "live" && !connection.joined && !connection.joinFailed}
    />
  );

  // ── Phases ────────────────────────────────────────────────────────────────
  if (phase === "prejoin") {
    return (
      <RoomShell top={top}>
        <GreenRoom
          kind={kind}
          title={title}
          name={self.name}
          media={self.broadcaster ? media : null}
          hosting={props.hosting}
          recordingNotice={props.recordingNotice}
          joining={busy === "joining"}
          error={actionError}
          onJoin={actions.join}
        />
      </RoomShell>
    );
  }

  if (phase !== "live") {
    return (
      <RoomShell top={top}>
        <EndScreen
          kind={kind}
          phase={phase}
          self={self}
          end={props.end ?? {}}
          backHref={backHref}
          busy={busy}
          error={actionError}
          pendingUploads={recording?.pendingUploads ?? 0}
          onRejoin={actions.rejoin}
          onReopen={actions.reopen}
        />
      </RoomShell>
    );
  }

  const selfMain =
    model.selfView === "deck" && presentation?.deck ? (
      <DeckPresenter deck={presentation.deck} onStop={presentation.stop} />
    ) : (
      <PresentingScreen stream={presentation?.stream ?? null} onStop={() => presentation?.stop()} />
    );

  const panelNode = panel
    ? panel.render({ tab, onTabChange: setTab, onUnread, open: panelOpen })
    : null;

  return (
    <>
      <RoomShell
        top={top}
        panel={panelNode}
        panelOpen={panelOpen}
        onClosePanel={closePanel}
        toasts={toasts}
        controls={
          <ControlBar
            kind={kind}
            media={self.broadcaster ? media : null}
            presentation={self.broadcaster ? presentation : null}
            recording={recording}
            reactions={reactions?.button ?? null}
            panel={
              panel
                ? { tabs: panel.tabs, open: panelOpen, tab, unread, onToggle: togglePanel }
                : null
            }
            onSettings={openDevices}
            leave={{
              canEnd: room.canEnd,
              onLeave: actions.leave,
              onEnd: actions.end,
              busy,
              error: actionError,
              hint: props.leaveHint ?? null,
            }}
          />
        }
      >
        <Stage
          model={model}
          view={view}
          onPin={onPin}
          pinForEveryone={kind === "webinar" && self.staff ? actions.pinForEveryone ?? null : null}
          selfMain={selfMain}
          selfThumb={(t) =>
            t.presenting === "screen" ? <PresentingThumb onStop={presentation?.stop} /> : null
          }
          empty={
            <StageNotice
              kind={emptyKind}
              startsAt={props.startsAt}
              message={connection.joinFailed?.message}
              onRetry={actions.retry}
            />
          }
          overlay={overlay}
          pipNotice={waitingChip}
        />
      </RoomShell>
      <AudioSinks peers={remotes} onBlocked={sinks.onBlocked} register={sinks.register} />
      <DevicePanel open={devicesOpen} onClose={closeDevices} media={self.broadcaster ? media : null} name={self.name} />
    </>
  );
}

function Chip({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <span
      className="inline-flex max-w-full items-center gap-2 truncate rounded-md bg-[rgba(20,20,22,0.85)] px-3 py-1.5 text-sm text-[#f4f4f5] ring-1 ring-[#34343a]"
      data-testid={testId}
    >
      {children}
    </span>
  );
}
