import type { ReactNode } from "react";
import type { DeviceLists } from "@/lib/media-devices";
import type { PresentationController } from "./use-presentation";

/**
 * What the room view is fed. Everything here is data the session controller
 * (B2: the page bindings around useLiveSession / useLocalMedia / useRoomRecording)
 * already has; the view adds only UI state (local pin, open panel, popovers).
 * Shapes are structural so the engine's objects can be passed straight in.
 */

export type RoomKind = "webinar" | "call";

/**
 * Where the person is:
 *   prejoin  green room
 *   live     in the room (the session may still be connecting — see RoomConnection)
 *   left     they left; the room carries on (Rejoin)
 *   ended    the room ended (webinar End for everyone, call ended/cancelled)
 *   closed   the server closed it for another reason (window over, access revoked)
 */
export type RoomPhase = "prejoin" | "live" | "left" | "ended" | "closed";

export type RoomSelf = {
  id: string;
  name: string;
  /** Sends camera and mic: webinar staff host or guest speaker; everyone on a call. */
  broadcaster: boolean;
  /** Webinar staff host / call staff side (Pin for everyone, recording control). */
  staff: boolean;
};

/** A remote broadcaster, as useLiveSession's RemotePeer gives it (subset). */
export type RoomPeer = {
  peerId: string;
  name: string;
  state: "idle" | "connecting" | "live" | "reconnecting" | "failed" | "left";
  /** Connected at least once this session. */
  seenLive: boolean;
  /** Present only while carrying media. */
  streams: { camera?: MediaStream; screen?: MediaStream; audio?: MediaStream };
};

export type DeviceStatus = "ready" | "denied" | "missing" | "error" | "off";

/** Camera + mic, as useLocalMedia returns them (subset). */
export type LocalMediaView = {
  stream: MediaStream | null;
  status: "idle" | "requesting" | "ready" | "denied" | "missing" | "unsupported" | "error";
  /** Per-device status when getUserMedia degraded (camera busy → mic only). Optional. */
  cameraStatus?: DeviceStatus;
  micStatus?: DeviceStatus;
  error: string | null;
  cameraOn: boolean;
  micOn: boolean;
  toggleCamera: () => void;
  toggleMic: () => void;
  /** Ask for permission again after a denial. */
  start: () => void;
  devices: DeviceLists;
  micId: string | null;
  cameraId: string | null;
  setMic: (deviceId: string) => void;
  setCamera: (deviceId: string) => void;
  switching: boolean;
  deviceError: string | null;
};

/** The engine's connection, for notices. */
export type RoomConnection = {
  state: "idle" | "connecting" | "live" | "reconnecting" | "failed" | "left";
  /** The join landed and the first peers were dialled. */
  joined: boolean;
  /** A non-fatal problem, shown as a banner. */
  error: string | null;
  /** The join was refused or failed for a reason that is not terminal: offer Retry. */
  joinFailed: { message: string } | null;
};

/** Server truth for the room (useLiveSession().room). */
export type RoomServerState = {
  /** Webinar primary host (pinned for everyone); null for calls. */
  primaryId: string | null;
  liveStartedAt: string | null;
  liveEndedAt: string | null;
  /** May THIS person End for everyone / End call right now. */
  canEnd: boolean;
  recording: { sessionId: string; byUserId: string; byName: string; startedAt: string } | null;
};

/** useRoomRecording's result plus whether this person may record. */
export type RoomRecordingView = {
  canRecord: boolean;
  state: "idle" | "starting" | "recording" | "stopping" | "error" | "unavailable";
  /** This tab is the recorder. */
  mine: boolean;
  by: { id: string; name: string } | null;
  elapsedMs: number;
  error: string | null;
  pendingUploads: number;
  start: () => void | Promise<void>;
  stop: () => void | Promise<void>;
};

export type PanelTab = "chat" | "qa" | "polls" | "people";
export type PanelUnread = { chat: number; qa: number; polls: number };

/** Webinar side panel (WS-C's <WebinarPanel/>), rendered with the shell's tab state. */
export type RoomPanelSlot = {
  /** Tabs to offer, in order. People only for hosts. */
  tabs: readonly PanelTab[];
  render: (ctx: {
    tab: PanelTab;
    onTabChange: (tab: PanelTab) => void;
    onUnread: (counts: PanelUnread) => void;
    /** The panel is on screen (it stays mounted while closed, so counts keep running). */
    open: boolean;
  }) => ReactNode;
};

/** Webinar reactions (WS-C): a control-bar button and an overlay inside the stage. */
export type RoomReactionsSlot = { button: ReactNode; overlay: ReactNode };

/** What ended, for the terminal screens. */
export type RoomEnd = {
  /** ISO time the room ended. */
  at?: string | null;
  /** This person pressed End. */
  byMe?: boolean;
  /** Webinar ended and was reopened since: offer Rejoin. */
  reopened?: boolean;
  /** Staff may Reopen an ended webinar. */
  canReopen?: boolean;
  /** Call: how long the person may rejoin after leaving. */
  rejoinUntil?: string | null;
  /** closed: why. */
  reason?: "closed" | "revoked" | "cancelled";
};

export type RoomBusy = "joining" | "leaving" | "ending" | "reopening" | "rejoining" | null;

export type RoomActions = {
  join: () => void;
  leave: () => void;
  /** End for everyone (webinar) / End call. Offered when `room.canEnd`. */
  end?: () => void;
  rejoin: () => void;
  reopen?: () => void;
  /** Retry a failed join. */
  retry: () => void;
  /** Webinar staff: make this host primary for everyone. */
  pinForEveryone?: (peerId: string) => void;
};

export type LiveRoomProps = {
  kind: RoomKind;
  title: string;
  self: RoomSelf;
  phase: RoomPhase;
  /** Back / close link (role-aware list page). */
  backHref: string;
  /** Webinar schedule start, for "Starts at …" / "isn't on air" copy. */
  startsAt?: string | null;
  /** Camera + mic; null for webinar viewers. */
  media: LocalMediaView | null;
  /** usePresentation(); null for webinar viewers. */
  presentation: PresentationController | null;
  remotes: readonly RoomPeer[];
  connection: RoomConnection;
  room: RoomServerState;
  /** Webinar hosts only: live viewers. */
  audienceCount?: number | null;
  recording?: RoomRecordingView | null;
  /** Green room: names of hosts already live (getHostingStatus). Null while loading. */
  hosting?: readonly string[] | null;
  /** Shown in the green room (everyone) whenever the session records or will. */
  recordingNotice?: ReactNode | null;
  /** Webinar only. */
  panel?: RoomPanelSlot | null;
  reactions?: RoomReactionsSlot | null;
  end?: RoomEnd;
  busy?: RoomBusy;
  /** The last action's error (join / end / reopen), shown where it happened. */
  actionError?: string | null;
  /** One short line in the Leave menu, e.g. "You're the only host on air." */
  leaveHint?: string | null;
  actions: RoomActions;
  /**
   * The layout everyone sees (no local pin) — feed it to useRoomRecording's
   * `layout` so the recording matches the room.
   */
  onSharedLayout?: (layout: { mainId: string | null; mainIsPresentation: boolean }) => void;
};
