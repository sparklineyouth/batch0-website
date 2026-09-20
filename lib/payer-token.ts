import { createHash, randomBytes } from "node:crypto";

/** A bearer capability with 256 bits of entropy. Only its hash is persisted. */
export function createPayerToken(): string { return randomBytes(32).toString("base64url"); }
export function isPayerToken(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}
export function hashPayerToken(token: string): string {
  if (!isPayerToken(token)) throw new Error("Invalid payment invitation");
  return createHash("sha256").update("batch0:payer-link:v1:").update(token).digest("hex");
}
export function payerLinkExpiresAt(now: Date, deadline: string | null): Date {
  return new Date(Math.min(now.getTime() + 24 * 60 * 60 * 1000, deadline ? Date.parse(deadline) : Infinity));
}
