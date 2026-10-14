/**
 * batch0 Live room UI kit (webinars and 1:1 calls).
 *
 * <LiveRoom {...props}/> is the whole room: green room, the live call surface
 * and the after-call screens. It is presentational: ./controller.tsx owns the
 * engine (useLiveSession, useLocalMedia, usePresentation, useRoomRecording)
 * and feeds it data and callbacks; /dev/live feeds it fake data. Every prop is
 * documented on LiveRoomProps (./types.ts). Stable data-testid attributes mark
 * controls and states for e2e (ctrl-*, tile-* with data-peer/data-kind,
 * stage[data-layout], green-room[data-cta], end-*, notice-*, badge-*,
 * device-*, deck-*, stage-notices, room-toasts).
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
  cameraKey,
  presentationKey,
  type StageInput,
  type StageModel,
  type StagePerson,
  type StageTile,
} from "./stage-model";
export type * from "./types";
