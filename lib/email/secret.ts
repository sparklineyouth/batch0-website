import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * Envelope encryption for the one secret this feature stores: the SMTP
 * password an admin pastes in to send through Gmail (or any relay).
 *
 * The row is service-role-only and RLS denies every browser read, so this is
 * defence in depth rather than the primary control. It earns its place
 * anyway: a Gmail app password is a bearer credential with no scope and no
 * expiry, and the places a database row leaks — a downloaded backup, a
 * support export, a misconfigured read policy added two years from now —
 * are exactly the places RLS isn't in the path.
 *
 * AES-256-GCM: authenticated, so a tampered ciphertext fails to decrypt
 * rather than producing garbage we'd then hand to an SMTP server.
 */

const VERSION = "v1";

/**
 * The key.
 *
 * `EMAIL_SECRET_KEY` when set — that's the one to use, and rotating it is
 * just "re-enter the SMTP password". Falling back to a hash of the service
 * role key means the feature works the moment the migration lands, without a
 * second env var to provision before an admin can connect Gmail. The fallback
 * is honest about what it is: it ties the ciphertext to a key that already
 * has full database access, so it protects against a leaked *backup*, not
 * against someone holding the service role key.
 */
function key(): Buffer {
  const explicit = process.env.EMAIL_SECRET_KEY;
  if (explicit && explicit.length >= 16) {
    return createHash("sha256").update(explicit).digest();
  }
  const fallback = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!fallback) {
    throw new Error(
      "Cannot encrypt SMTP credentials: set EMAIL_SECRET_KEY (or SUPABASE_SERVICE_ROLE_KEY).",
    );
  }
  return createHash("sha256").update(`batch0-email:${fallback}`).digest();
}

/** `v1.<iv>.<tag>.<ciphertext>`, all base64url. */
export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString("base64url"),
    tag.toString("base64url"),
    ct.toString("base64url"),
  ].join(".");
}

/**
 * Decrypt, or null.
 *
 * Null rather than a throw because the realistic failure is an operational
 * one — the key rotated, or the row was restored from a backup taken under a
 * different key — and the right response is "SMTP isn't configured, fall back
 * to Resend and tell the admin to re-enter it", not a 500 on every send.
 */
export function decryptSecret(payload: string | null | undefined): string | null {
  if (!payload) return null;
  try {
    const [version, ivB64, tagB64, ctB64] = payload.split(".");
    if (version !== VERSION || !ivB64 || !tagB64 || !ctB64) return null;
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key(),
      Buffer.from(ivB64, "base64url"),
    );
    decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(ctB64, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return null;
  }
}
