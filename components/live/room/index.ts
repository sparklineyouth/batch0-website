/**
 * batch0 Live room UI kit (webinars and 1:1 calls).
 *
 * <LiveRoom {...props}/> is the whole room: green room, the live call surface
 * and the after-call screens. It is presentational — the page binding owns
 * the engine and passes data + callbacks. Wiring (B2) in outline:
 *
 *   const media = useLocalMedia({ autoStart: canBroadcast && phase !== "ended" });
 *   const presentation = usePresentation({ enabled: canBroadcast, eventDeck }); // eventDeck memoised
 *     // eventDeck: { url, name } — a signed URL of the event's PDF deck. The
 *     // deck reads the first slides by range and downloads the rest in the
 *     // background; sign it for at least an hour.
 *   const session = useLiveSession({ ..., localStream: media.stream,
 *                                    screenStream: presentation.stream, ... });
 *   const [layout, setLayout] = useState({ mainId: null, mainIsPresentation: false });
 *   const recording = useRoomRecording({ ..., screenStream: presentation.stream, layout });
 *   <LiveRoom
 *     kind="webinar" | "call"         title, backHref, startsAt (webinar schedule)
 *     self={{ id, name, broadcaster, staff }}
 *     phase="prejoin" | "live" | "left" | "ended" | "closed"
 *     media={canBroadcast ? media : null}  presentation={canBroadcast ? presentation : null}
 *     remotes={session.remotes}
 *     connection={{ state: session.state, joined: session.joined, error: session.error,
 *                   joinFailed: session.joinFailed && { message } }}
 *     room={session.room ?? fallback}       // LiveRoomState: primaryId, canEnd, recording, …
 *     audienceCount={session.audienceCount} // hosts only
 *     recording={recording}                 // the hook's object as is — never spread it
 *     canRecord={canRecord}                 // webinar staff host / call staff
 *     hosting={names from getHostingStatus} // webinar green room CTA
 *     recordingNotice={…}                   // green room, everyone, when it records
 *     panel={{ tabs: panelTabs(role, chatOn),            // lib/webinar-panel: the panel's own tabs
 *              render: ({ tab, onTabChange, onUnread }) => <WebinarPanel … /> }}
 *     reactions={{ button: <ReactionsButton …/>, overlay: <ReactionsOverlay …/> }}
 *     end={{ at, byMe, reopened, canReopen, rejoinUntil, reason }}
 *     busy / actionError / leaveHint
 *     actions={{ join, leave, end, rejoin, reopen, retry, pinForEveryone }}
 *     onSharedLayout={setLayout}            // recording follows what the room sees
 *   />
 *
 * Every prop is documented on LiveRoomProps (./types.ts). Stable data-testid
 * attributes mark controls and states for e2e (ctrl-*, tile-*, stage[data-layout],
 * green-room[data-cta], end-*, notice-*, badge-*, device-*, deck-*, stage-notices,
 * room-toasts).
 */
export { LiveRoom } from "./live-room";
export { RoomShell, TopBar } from "./shell";
export { Stage } from "./stage";
export { Tile } from "./tile";
export { ControlBar } from "./controls";
export { GreenRoom } from "./devices/green-room";
export { DevicePanel } from "./devices/device-panel";
export { DeviceControls, MicMeter } from "./devices/device-controls";
export { playTestSound, useMicTest } from "./devices/tests";
export { DeckPresenter } from "./deck/deck-presenter";
export { DeckEngine, type DeckOpenResult, type DeckSnapshot, type DeckSource } from "./deck/deck-engine";
export { EndScreen, StageNotice, UploadingRecording } from "./screens";
export { AudioSinks, useAudioSinks } from "./audio-sinks";
export { useSpeaking, useAudioLevel, resumeAudio } from "./audio-levels";
export {
  usePresentation,
  useDeckSnapshot,
  type PresentationController,
  type PresentationKind,
  type EventDeck,
} from "./use-presentation";
export { useScreenShare, DISPLAY_MEDIA_OPTIONS } from "./use-screen-share";
export { useRoomShortcuts } from "./use-shortcuts";
export {
  computeStage,
  sharedLayout,
  cameraKey,
  presentationKey,
  type StageInput,
  type StageModel,
  type StagePerson,
  type StageTile,
} from "./stage-model";
export type * from "./types";
