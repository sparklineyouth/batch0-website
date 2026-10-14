"use client";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { LocalTime } from "@/components/ui/local-time";
import { useAudioSinks, AudioSinks } from "./audio-sinks";
import { ControlBar } from "./controls";
import { DeckPresenter } from "./deck/deck-presenter";
import { DevicePanel } from "./devices/device-panel";
import { GreenRoom } from "./devices/green-room";
import { joinNames, stageNotice } from "./logic";
import { PopoverProvider, useCloseAllPopovers } from "./popover";
import { PresentingScreen } from "./presenting";
import { EndScreen, StageNotice } from "./screens";
import { RoomShell, TopBar } from "./shell";
import { PresentingDeckThumb, PresentingThumb, Stage, type TileView } from "./stage";
import { computeStage, type StagePerson, type StageTile } from "./stage-model";
import { ToastProvider, useToasts } from "./toasts";
import type { LiveRoomProps, PanelTab, PanelUnread, RoomPeer } from "./types";
import { useRoomShortcuts } from "./use-shortcuts";
import { DESKTOP_QUERY, PANEL_COLUMN_QUERY, useMediaQuery } from "./use-size";
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
    if (hasPanel && window.matchMedia?.(DESKTOP_QUERY).matches) setPanelOpen(true);
  }, [hasPanel]);

  const onPopoverOpen = useCallback(() => {
    if (!window.matchMedia?.(PANEL_COLUMN_QUERY).matches) setPanelOpen(false);
  }, []);

  return (
    <PopoverProvider onOpen={onPopoverOpen}>
      <ToastProvider>
        {(toasts, toastCount) => (
          <RoomBody
            {...props}
            toasts={toasts}
            toastCount={toastCount}
            panelOpen={panelOpen}
            setPanelOpen={setPanelOpen}
          />
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
    toastCount: number;
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
    canRecord = false,
    panel = null,
    reactions = null,
    actions,
    busy = null,
    actionError = null,
    toasts,
    toastCount,
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
  const flash = props.flash ?? null;
  useEffect(() => {
    if (flash) toast.push({ id: flash.id, tone: "info", message: flash.message });
  }, [flash, toast]);

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
  // The shared view, never this viewer's pin: what the recorder composes.
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

  // Pin for everyone, said where it was pressed: the presser's own stage may
  // not move (their local pin wins there).
  const pinAction = actions.pinForEveryone;
  const nameOf = useRef<(id: string) => string>(() => "");
  nameOf.current = (id) => (id === self.id ? self.name : remotes.find((r) => r.peerId === id)?.name || "That host");
  const pinForEveryone = useMemo(
    () =>
      pinAction
        ? (peerId: string) => {
            const failed = (message: string) => toast.push({ id: "pin", tone: "error", message });
            void Promise.resolve(pinAction(peerId))
              .then((r) => {
                if (!r) return;
                if (!r.ok) return failed(r.error);
                toast.push({
                  id: "pin",
                  tone: "info",
                  message:
                    peerId === self.id
                      ? "You're on the main stage for everyone"
                      : `${nameOf.current(peerId)} is on the main stage for everyone`,
                });
              })
              .catch(() => failed("Couldn't pin that host. Try again."));
          }
        : null,
    [pinAction, self.id, toast],
  );

  // Another presentation holds the main stage (the primary's always does; else
  // the most recent): a presenter is told theirs waits, and drives their
  // slides from the filmstrip card meanwhile.
  const otherPresenterId = shared.presenter && !shared.presenter.isSelf ? shared.presenter.peerId : null;
  const otherPresenterName = otherPresenterId ? shared.presenter?.name || "Someone" : null;
  useEffect(() => {
    if (phase !== "live" || !selfPresenting || !otherPresenterId) return;
    toast.push({
      id: "presenting-behind",
      tone: "info",
      message: `${otherPresenterName} is presenting. Yours shows when they stop.`,
    });
  }, [phase, selfPresenting, otherPresenterId, otherPresenterName, toast]);
  // Starting one now wouldn't take the stage: the Present menu says so first.
  const presentHeldBy = kind === "webinar" && otherPresenterId && otherPresenterId === primaryId ? otherPresenterName : null;

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
  const emptyKind = stageNotice({
    joinFailed: !!connection.joinFailed,
    joined: connection.joined,
    peers: remotes,
    hadHost: hadHost.current,
    liveStartedAt: room.liveStartedAt,
    startsAt: props.startsAt,
    now: Date.now(),
  });

  // A call says who left, and until when they can come back.
  const rejoinUntil = props.end?.rejoinUntil ?? null;
  const alone = kind === "call" && model.why === "alone";
  let waitingChip: ReactNode = null;
  if (alone && connection.joined) {
    const away = remotes.filter((r) => !onStage(r));
    const left = away.filter((r) => r.state === "left").map((r) => r.name);
    // On the page (signalling) but the link isn't up yet, vs not here at all.
    const coming = away.filter((r) => r.state !== "left" && r.heard).map((r) => r.name);
    const waiting = away.filter((r) => r.state !== "left" && !r.heard).map((r) => r.name);
    const text: ReactNode = left.length ? (
      <>
        <span>{joinNames(left)} left the call.</span>
        {rejoinUntil ? (
          <span className="text-[#a1a1aa]">
            They can rejoin until <LocalTime value={rejoinUntil} mode="time" />.
          </span>
        ) : null}
      </>
    ) : coming.length
        ? `Connecting to ${joinNames(coming)}…`
        : waiting.length
          ? `Waiting for ${joinNames(waiting)} to join`
          : "Waiting for others to join";
    waitingChip = (
      <Chip testId="chip-waiting" wrap={left.length > 0}>
        {text}
      </Chip>
    );
  }

  // With others still on the stage (no chip), a toast says it instead.
  const leftIds = remotes
    .filter((r) => r.state === "left")
    .map((r) => r.peerId)
    .sort()
    .join(",");
  const announcedLeft = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (kind !== "call" || phase !== "live") return;
    const now = new Set(leftIds ? leftIds.split(",") : []);
    for (const id of now) {
      if (announcedLeft.current.has(id) || alone) continue;
      const who = remotes.find((r) => r.peerId === id)?.name || "Someone";
      const until = rejoinUntil
        ? ` They can rejoin until ${new Date(rejoinUntil).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.`
        : "";
      toast.push({ id: `left:${id}`, tone: "info", message: `${who} left the call.${until}` });
    }
    announcedLeft.current = now;
    // `remotes` is read for names only; the ids decide when this runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, phase, leftIds, rejoinUntil, alone, toast]);

  // A refused join is the "Couldn't join" notice; the same text isn't bannered too.
  const [hiddenError, setHiddenError] = useState<string | null>(null);
  const banner =
    connection.error && !connection.joinFailed && connection.error !== hiddenError ? (
      <div
        className="pointer-events-auto flex w-full max-w-xl items-center gap-2 rounded-md border border-[#4a3a12] bg-[#241d0c] px-3 py-2 text-sm text-[#ffe3a3]"
        data-testid="banner-error"
      >
        <span className="min-w-0 flex-1">{connection.error}</span>
        <button
          type="button"
          className="shrink-0 text-xs font-semibold text-[#FFBB00] hover:underline"
          onClick={() => setHiddenError(connection.error)}
        >
          Dismiss
        </button>
      </div>
    ) : null;

  // Phones with the chat sheet open: notices and toasts go in the sheet,
  // above the chat (the sheet covers all but a sliver of the stage).
  const column = useMediaQuery(PANEL_COLUMN_QUERY);
  const sheetOpen = !!panel && panelOpen && !column;

  const reconnectingChip =
    connection.state === "reconnecting" && model.layout !== "empty" ? (
      <Chip testId="veil-reconnecting">
        <Spinner className="h-3.5 w-3.5" /> Reconnecting…
      </Chip>
    ) : null;
  const noticeChip = props.notice ? (
    <Chip testId="chip-notice" wrap>
      {props.notice}
    </Chip>
  ) : null;
  const stageNotices =
    banner || reconnectingChip || noticeChip || waitingChip ? (
      <>
        {banner}
        {reconnectingChip}
        {noticeChip}
        {waitingChip}
      </>
    ) : null;
  const notices = sheetOpen ? null : (
    <>
      {stageNotices}
      {toasts}
    </>
  );
  const sheetNotices =
    sheetOpen && (stageNotices || toastCount > 0) ? (
      <div className="flex flex-col items-center gap-2">
        {stageNotices}
        {toastCount > 0 ? toasts : null}
      </div>
    ) : null;

  const overlay = (
    <>
      {connection.joinFailed && model.layout !== "empty" ? (
        <div className="absolute inset-0 z-[12] grid place-items-center rounded-md bg-[rgba(12,12,14,0.85)]">
          <StageNotice kind="failed" message={connection.joinFailed.message} onRetry={actions.retry} />
        </div>
      ) : null}
      {reactions ? (
        // The overlay places itself (bottom-right of this box, full height).
        <div className="pointer-events-none absolute inset-0 z-10 overflow-hidden">{reactions.overlay}</div>
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
  // A webinar is live once the server says it started (a host rehearsing
  // before the room opens is not); a call once its link is up.
  const live =
    phase === "live" &&
    (kind === "webinar" ? !!room.liveStartedAt && !room.liveEndedAt : connection.state === "live");
  // Everyone sees REC: the server's word, or this tab's own take / refused start.
  const recBy = recording?.mine ? null : (room.recording?.byName ?? recording?.by?.name ?? null);
  const recActive = phase === "live" && (!!room.recording || !!recording?.mine || !!recording?.by);
  const subline = phase === "live" ? (props.subline ?? null) : null;
  const top = (
    <>
      <TopBar
        title={phase === "prejoin" ? "" : title}
        // The end screens have their own Back, which waits for the recording's upload.
        backHref={phase === "prejoin" ? backHref : null}
        live={live}
        rec={recActive ? { by: recBy } : null}
        since={phase === "live" ? (kind === "webinar" ? room.liveStartedAt : firstLive.current) : null}
        audienceCount={phase === "live" ? props.audienceCount : null}
        role={phase === "live" && kind === "webinar" ? (self.broadcaster ? "Hosting" : "Watching") : null}
        connecting={phase === "live" && !connection.joined && !connection.joinFailed}
      />
      {subline ? (
        <p
          className="-mt-1 shrink-0 px-3 pb-1.5 text-[11px] leading-snug text-[#a1a1aa] sm:px-4 sm:text-xs"
          data-testid="room-subline"
        >
          {subline}
        </p>
      ) : null}
    </>
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
          primary={!!props.hostingPrimary}
          recordingNotice={props.recordingNotice}
          joining={busy === "joining"}
          error={actionError}
          rehearsalUntil={props.rehearsalUntil ?? null}
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
          onBack={actions.back}
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
        sheetNotices={sheetNotices}
        controls={
          <ControlBar
            kind={kind}
            selfId={self.id}
            media={self.broadcaster ? media : null}
            presentation={self.broadcaster ? presentation : null}
            presentHeldBy={presentHeldBy}
            recording={canRecord ? recording : null}
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
              error: props.endError ?? null,
              hint: props.leaveHint ?? null,
            }}
          />
        }
      >
        <Stage
          model={model}
          view={view}
          onPin={onPin}
          pinForEveryone={kind === "webinar" && self.staff ? pinForEveryone : null}
          selfMain={selfMain}
          selfThumb={(t) =>
            t.presenting === "screen" ? (
              <PresentingThumb onStop={presentation?.stop} />
            ) : t.presenting === "deck" && presentation?.deck ? (
              <PresentingDeckThumb deck={presentation.deck} onStop={presentation.stop} />
            ) : null
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
          notices={notices}
        />
      </RoomShell>
      <AudioSinks peers={remotes} onBlocked={sinks.onBlocked} register={sinks.register} />
      <DevicePanel open={devicesOpen} onClose={closeDevices} media={self.broadcaster ? media : null} name={self.name} />
    </>
  );
}

function Chip({ children, testId, wrap = false }: { children: ReactNode; testId?: string; wrap?: boolean }) {
  return (
    <span
      className={`inline-flex max-w-full items-center rounded-md bg-[rgba(20,20,22,0.85)] px-3 py-1.5 text-sm text-[#f4f4f5] ring-1 ring-[#34343a] ${
        wrap ? "flex-wrap justify-center gap-x-2 text-center" : "gap-2 truncate"
      }`}
      data-testid={testId}
    >
      {children}
    </span>
  );
}
