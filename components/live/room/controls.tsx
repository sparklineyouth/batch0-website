"use client";
import { useRef, useState, type ReactNode } from "react";
import {
  BarChart3,
  Circle,
  CircleDot,
  FileText,
  LogOut,
  MessageCircleQuestion,
  MessageSquare,
  Mic,
  MicOff,
  MonitorUp,
  MonitorX,
  MoreVertical,
  PhoneOff,
  Settings,
  Square,
  Users,
  Video,
  VideoOff,
} from "lucide-react";
import { formatElapsed } from "./logic";
import { MenuItem, Popover, usePopover } from "./popover";
import type { PresentationController } from "./use-presentation";
import type {
  LocalMediaView,
  PanelTab,
  PanelUnread,
  RoomBusy,
  RoomKind,
  RoomRecordingView,
} from "./types";
import { Badge, FOCUS, RoomButton } from "./ui";

/**
 * The pinned control bar. Desktop: mic, camera, present, record, reactions,
 * settings, leave in the middle; panel toggles on the right. Phones: mic,
 * camera, present, reactions, panel, "more" (record, settings), leave.
 * Menus open upwards as popovers; nothing here ever reflows.
 */

const TAB_META: Record<PanelTab, { label: string; icon: ReactNode }> = {
  chat: { label: "Chat", icon: <MessageSquare className="h-5 w-5" /> },
  qa: { label: "Q&A", icon: <MessageCircleQuestion className="h-5 w-5" /> },
  polls: { label: "Polls", icon: <BarChart3 className="h-5 w-5" /> },
  people: { label: "People", icon: <Users className="h-5 w-5" /> },
};

function unreadFor(tab: PanelTab, u: PanelUnread): number {
  return tab === "people" ? 0 : u[tab];
}

export type ControlBarProps = {
  kind: RoomKind;
  media: LocalMediaView | null;
  presentation: PresentationController | null;
  recording: RoomRecordingView | null;
  reactions: ReactNode | null;
  panel: {
    tabs: readonly PanelTab[];
    open: boolean;
    tab: PanelTab;
    unread: PanelUnread;
    onToggle: (tab: PanelTab) => void;
  } | null;
  onSettings: () => void;
  leave: {
    canEnd: boolean;
    onLeave: () => void;
    onEnd?: () => void;
    busy: RoomBusy;
    error: string | null;
    hint: string | null;
  };
};

export function ControlBar(props: ControlBarProps) {
  const { media, presentation, recording, reactions, panel, onSettings, leave, kind } = props;
  const showRecord = !!recording && recording.canRecord && recording.state !== "unavailable";
  const totalUnread = panel
    ? panel.tabs.reduce((n, t) => n + unreadFor(t, panel.unread), 0)
    : 0;

  return (
    <div className="flex h-full items-center gap-2 px-3 sm:px-4" data-testid="control-bar">
      {/* Left spacer keeps the middle group centred on desktop. */}
      <div className="hidden flex-1 lg:block" />

      <div className="flex min-w-0 flex-1 items-center justify-center gap-1.5 sm:gap-2 lg:flex-none">
        {media ? <MicButton media={media} /> : null}
        {media ? <CameraButton media={media} /> : null}
        {presentation ? <PresentButton presentation={presentation} /> : null}
        {showRecord ? (
          <div className="hidden sm:block">
            <RecordButton recording={recording!} />
          </div>
        ) : null}
        {reactions ? <div className="shrink-0">{reactions}</div> : null}
        <div className="hidden sm:block">
          <CtrlButton label="Audio & video settings" onClick={onSettings} testId="ctrl-settings">
            <Settings className="h-5 w-5" />
          </CtrlButton>
        </div>
        {panel ? (
          <div className="lg:hidden">
            <CtrlButton
              label={panel.open ? "Close chat" : "Chat"}
              on={panel.open}
              onClick={() => panel.onToggle(panel.tab)}
              testId="ctrl-panel"
            >
              <MessageSquare className="h-5 w-5" />
              <Badge count={panel.open ? 0 : totalUnread} />
            </CtrlButton>
          </div>
        ) : null}
        <div className="sm:hidden">
          <MoreMenu recording={showRecord ? recording : null} onSettings={onSettings} />
        </div>
        <LeaveButton kind={kind} {...leave} />
      </div>

      <div className="hidden flex-1 items-center justify-end gap-2 lg:flex">
        {panel?.tabs.map((t) => (
          <CtrlButton
            key={t}
            label={TAB_META[t].label}
            on={panel.open && panel.tab === t}
            onClick={() => panel.onToggle(t)}
            testId={`ctrl-tab-${t}`}
          >
            {TAB_META[t].icon}
            <Badge count={panel.open && panel.tab === t ? 0 : unreadFor(t, panel.unread)} />
          </CtrlButton>
        ))}
      </div>
    </div>
  );
}

function CtrlButton({
  label,
  onClick,
  on = false,
  danger = false,
  children,
  testId,
  disabled,
  busy,
  buttonRef,
  expanded,
  pressed,
}: {
  label: string;
  onClick: () => void;
  on?: boolean;
  danger?: boolean;
  children: ReactNode;
  testId?: string;
  disabled?: boolean;
  busy?: boolean;
  buttonRef?: React.Ref<HTMLButtonElement>;
  expanded?: boolean;
  pressed?: boolean;
}) {
  return (
    <RoomButton
      ref={buttonRef}
      size="icon"
      variant={danger ? "danger" : on ? "on" : "control"}
      aria-label={label}
      title={label}
      onClick={onClick}
      data-testid={testId}
      disabled={disabled}
      busy={busy}
      aria-expanded={expanded}
      aria-pressed={pressed}
    >
      {children}
    </RoomButton>
  );
}

function MicButton({ media }: { media: LocalMediaView }) {
  const label = media.micOn ? "Turn microphone off" : "Turn microphone on";
  return (
    <CtrlButton
      label={`${label} (Ctrl+D)`}
      danger={!media.micOn}
      onClick={media.toggleMic}
      testId="ctrl-mic"
      pressed={!media.micOn}
    >
      {media.micOn ? <Mic className="h-5 w-5" /> : <MicOff className="h-5 w-5" />}
    </CtrlButton>
  );
}

function CameraButton({ media }: { media: LocalMediaView }) {
  const label = media.cameraOn ? "Turn camera off" : "Turn camera on";
  return (
    <CtrlButton
      label={`${label} (Ctrl+E)`}
      danger={!media.cameraOn}
      onClick={media.toggleCamera}
      testId="ctrl-camera"
      pressed={!media.cameraOn}
    >
      {media.cameraOn ? <Video className="h-5 w-5" /> : <VideoOff className="h-5 w-5" />}
    </CtrlButton>
  );
}

function PresentButton({ presentation: p }: { presentation: PresentationController }) {
  const anchor = useRef<HTMLButtonElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const pop = usePopover("present");
  const presenting = p.kind !== "none";
  const close = () => pop.setOpen(false);

  return (
    <>
      <CtrlButton
        label={presenting ? "Presenting" : "Present"}
        on={presenting}
        onClick={pop.toggle}
        buttonRef={anchor}
        testId="ctrl-present"
        busy={p.deckLoading || p.screenPending}
        expanded={pop.open}
      >
        <MonitorUp className="h-5 w-5" />
      </CtrlButton>
      <input
        ref={file}
        type="file"
        accept="application/pdf,.pdf"
        className="hidden"
        data-testid="deck-file"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) p.startDeck(f);
        }}
      />
      <Popover anchor={anchor} open={pop.open} onClose={close} label="Present" testId="present-menu">
        {p.screenSupported && p.kind !== "screen" ? (
          <MenuItem
            icon={<MonitorUp />}
            testId="present-screen"
            onClick={() => {
              close();
              p.startScreen();
            }}
          >
            Share screen
          </MenuItem>
        ) : null}
        {p.eventDeck ? (
          <MenuItem
            icon={<FileText />}
            testId="present-event-deck"
            hint={p.eventDeck.name}
            onClick={() => {
              close();
              p.startDeck("event");
            }}
          >
            Present slides
          </MenuItem>
        ) : null}
        <MenuItem
          icon={<FileText />}
          testId="present-pdf"
          onClick={() => {
            close();
            file.current?.click();
          }}
        >
          {p.eventDeck ? "Present another PDF" : "Present slides (PDF)"}
        </MenuItem>
        {presenting ? (
          <MenuItem
            icon={<MonitorX />}
            tone="danger"
            testId="present-stop"
            onClick={() => {
              close();
              p.stop();
            }}
          >
            Stop presenting
          </MenuItem>
        ) : null}
      </Popover>
    </>
  );
}

function RecordButton({ recording: r }: { recording: RoomRecordingView }) {
  const anchor = useRef<HTMLButtonElement>(null);
  const pop = usePopover("record");
  const recordingNow = r.state === "recording";
  const someoneElse = recordingNow && !r.mine;
  const busy = r.state === "starting" || r.state === "stopping";

  if (someoneElse) {
    return (
      <CtrlButton
        label={`Recording by ${r.by?.name ?? "another host"}`}
        onClick={() => {}}
        disabled
        testId="ctrl-record"
      >
        <Circle className="h-5 w-5 fill-[#e5484d] text-[#e5484d]" />
      </CtrlButton>
    );
  }
  if (!recordingNow) {
    return (
      <CtrlButton label="Record" onClick={() => void r.start()} busy={busy} testId="ctrl-record">
        <CircleDot className="h-5 w-5" />
      </CtrlButton>
    );
  }
  return (
    <>
      <RoomButton
        ref={anchor}
        variant="control"
        className="h-10 gap-2 px-3 sm:h-11"
        aria-label="Stop recording"
        title="Stop recording"
        onClick={pop.toggle}
        busy={busy}
        aria-expanded={pop.open}
        data-testid="ctrl-record"
      >
        <Square className="h-3.5 w-3.5 fill-[#e5484d] text-[#e5484d]" />
        <span className="text-xs tabular-nums">{formatElapsed(r.elapsedMs)}</span>
      </RoomButton>
      <Popover anchor={anchor} open={pop.open} onClose={() => pop.setOpen(false)} label="Stop recording" role="dialog">
        <div className="space-y-3 p-2" data-testid="record-confirm">
          <p className="text-sm text-[#f4f4f5]">Stop recording?</p>
          <div className="flex gap-2">
            <RoomButton
              variant="danger"
              size="sm"
              onClick={() => {
                pop.setOpen(false);
                void r.stop();
              }}
              data-testid="record-stop"
            >
              Stop recording
            </RoomButton>
            <RoomButton variant="ghost" size="sm" onClick={() => pop.setOpen(false)}>
              Keep recording
            </RoomButton>
          </div>
        </div>
      </Popover>
    </>
  );
}

function MoreMenu({ recording, onSettings }: { recording: RoomRecordingView | null; onSettings: () => void }) {
  const anchor = useRef<HTMLButtonElement>(null);
  const pop = usePopover("more");
  const close = () => pop.setOpen(false);
  const r = recording;
  return (
    <>
      <CtrlButton label="More" onClick={pop.toggle} buttonRef={anchor} testId="ctrl-more" expanded={pop.open}>
        <MoreVertical className="h-5 w-5" />
      </CtrlButton>
      <Popover anchor={anchor} open={pop.open} onClose={close} label="More" align="end" testId="more-menu">
        {r && r.state !== "recording" ? (
          <MenuItem
            icon={<CircleDot />}
            onClick={() => {
              close();
              void r.start();
            }}
            disabled={r.state === "starting" || r.state === "stopping"}
            testId="more-record"
          >
            Record
          </MenuItem>
        ) : null}
        {r && r.state === "recording" && r.mine ? (
          <MenuItem
            icon={<Square />}
            tone="danger"
            onClick={() => {
              close();
              void r.stop();
            }}
            testId="more-record-stop"
            hint={formatElapsed(r.elapsedMs)}
          >
            Stop recording
          </MenuItem>
        ) : null}
        {r && r.state === "recording" && !r.mine ? (
          <MenuItem icon={<Circle />} onClick={close} disabled>
            Recording by {r.by?.name ?? "another host"}
          </MenuItem>
        ) : null}
        <MenuItem
          icon={<Settings />}
          onClick={() => {
            close();
            onSettings();
          }}
          testId="more-settings"
        >
          Audio &amp; video
        </MenuItem>
      </Popover>
    </>
  );
}

function LeaveButton({
  kind,
  canEnd,
  onLeave,
  onEnd,
  busy,
  error,
  hint,
}: { kind: RoomKind } & ControlBarProps["leave"]) {
  const anchor = useRef<HTMLButtonElement>(null);
  const pop = usePopover("leave");
  const [confirming, setConfirming] = useState(false);
  const endLabel = kind === "call" ? "End call" : "End for everyone";
  const offerEnd = canEnd && !!onEnd;
  const close = () => {
    pop.setOpen(false);
    setConfirming(false);
  };

  return (
    <>
      <RoomButton
        ref={anchor}
        variant="danger"
        className="h-10 gap-2 px-3 sm:h-11 sm:px-4"
        aria-label="Leave"
        title="Leave"
        aria-haspopup="menu"
        aria-expanded={pop.open}
        onClick={() => {
          setConfirming(false);
          pop.toggle();
        }}
        busy={busy === "leaving" || busy === "ending"}
        data-testid="ctrl-leave"
      >
        <PhoneOff className="h-5 w-5" />
        <span className="hidden text-sm md:inline">Leave</span>
      </RoomButton>
      <Popover
        anchor={anchor}
        open={pop.open}
        onClose={close}
        label="Leave"
        align="end"
        role={confirming ? "dialog" : "menu"}
        testId="leave-menu"
      >
        {!confirming ? (
          <>
            {hint ? <p className="px-3 pb-1 pt-2 text-xs text-[#a1a1aa]">{hint}</p> : null}
            <MenuItem icon={<LogOut />} onClick={() => { close(); onLeave(); }} testId="leave-leave">
              Leave
            </MenuItem>
            {offerEnd ? (
              <MenuItem icon={<PhoneOff />} tone="danger" onClick={() => setConfirming(true)} testId="leave-end">
                {endLabel}
              </MenuItem>
            ) : null}
          </>
        ) : (
          <div className="space-y-3 p-2" data-testid="leave-confirm">
            <p className="text-sm text-[#f4f4f5]">
              {kind === "call" ? "End the call for everyone?" : "End the webinar for everyone?"}
            </p>
            {error ? (
              <p className="text-xs text-[#ff8a8d]" role="alert">
                {error}
              </p>
            ) : null}
            <div className="flex gap-2">
              <RoomButton
                variant="danger"
                size="sm"
                busy={busy === "ending"}
                onClick={() => onEnd?.()}
                data-testid="leave-end-confirm"
              >
                {endLabel}
              </RoomButton>
              <RoomButton variant="ghost" size="sm" onClick={() => setConfirming(false)} className={FOCUS}>
                Cancel
              </RoomButton>
            </div>
          </div>
        )}
      </Popover>
    </>
  );
}
