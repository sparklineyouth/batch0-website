/**
 * Every harness state and its variants (`/dev/live?state=<key>&w=<variant>`).
 * Import-free: scripts/room-screens.mts reads it under plain node.
 */
export const HARNESS_STATES: Record<string, readonly string[]> = {
  prejoin: ["host", "cohost", "viewer", "call", "denied"],
  connecting: ["viewer", "host"],
  "live-host": ["default", "solo", "panel", "leave", "devices", "rec", "rec-other", "reconnecting", "error", "failed"],
  "live-viewer": ["default", "panel", "waiting", "starts", "away", "reconnecting", "failed"],
  "presenting-screen": ["self", "viewer", "portrait", "call"],
  "presenting-deck": ["file", "event", "viewer"],
  "call-2": ["default", "waiting", "left", "pin-self", "present"],
  "call-4": ["default", "present", "reconnecting"],
  ended: ["viewer", "host", "byme", "reopened", "left", "left-call", "call", "cancelled", "closed", "revoked", "uploading"],
};
