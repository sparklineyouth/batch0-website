import { createHmac } from "node:crypto";

/**
 * batch0 Live channel keys: base64url HMAC-SHA256, truncated to 128 bits.
 *
 * The `purpose` prefix domain-separates the uses (inbox, lobby, room, …), so
 * one key can never be replayed as another even for the same room. Parts are
 * joined with U+0000, which no id or purpose contains, so ("a", "bc") and
 * ("ab", "c") can never collide.
 *
 * Pure (node:crypto only) so lib/live-signal.test.ts can pin its output: every
 * live room's topics are derived from it, and a change in output would split a
 * room mid-deploy between old and new tabs.
 *
 * Server-side only by use: lib/live-rooms.ts (server-only) is the one caller,
 * and it alone holds the secret.
 */
export function deriveKey(
  secret: string,
  purpose: string,
  ...parts: string[]
): string {
  return createHmac("sha256", secret)
    .update([purpose, ...parts].join("\u0000"))
    .digest("base64url")
    .slice(0, 22);
}

/**
 * The parts a 1:1 pair key is derived from (purpose "pair"): the room, then
 * the two people's ids in a fixed order, so each end of the pair is handed
 * the same line whichever of them asks.
 */
export function pairKeyParts(
  roomId: string,
  a: string,
  b: string,
): [string, string, string] {
  return a < b ? [roomId, a, b] : [roomId, b, a];
}
