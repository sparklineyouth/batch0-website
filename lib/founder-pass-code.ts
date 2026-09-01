// Founder-pass code primitives: how a code typed by a human becomes the hash
// stored in the database.
//
// This module is imported by BOTH the running site (app/pass/actions.ts) and
// the offline minting script (scripts/mint-cards.mts). That is the whole point
// of it existing separately: if the script and the site ever disagreed by one
// character about what a code hashes to, every card in circulation would fail
// to redeem, and the failure would look like "the codes are wrong" rather than
// "the two hashers drifted". Keep it dependency-free (node:crypto only) so
// plain `node scripts/*.mts` runs it via Node's native type stripping, with no
// build step and no bundler.

import { createHmac, randomInt } from "node:crypto";

/**
 * Alphabet used when MINTING new codes. Deliberately excludes characters that
 * get misread off a physical object under bad lighting: 0/O, 1/I/L, 2/Z, 5/S,
 * 8/B. Someone is retyping this from a piece of plastic in their hand, and a
 * code they can't transcribe is a support ticket.
 *
 * This constrains what we PRINT, not what we ACCEPT — see normalizePassCode,
 * which stays permissive so codes from earlier print runs (which may use any
 * alphabet) still redeem.
 */
export const MINT_ALPHABET = "34679ACDEFGHJKMNPQRTUVWXY";

/** Length of newly minted codes. 25^8 ~= 1.5e11 — see SECURITY note below. */
export const MINT_LENGTH = 8;

/**
 * Fold a code as typed by a human into its canonical form.
 *
 * Permissive on purpose: people add spaces, hyphens, and random capitals when
 * copying off a card. We strip anything that isn't alphanumeric and lowercase
 * the rest, so "a3-9f k2" and "A39FK2" are the same code.
 *
 * NOTE what this deliberately does NOT do: fold visually ambiguous characters
 * (O->0, I->1). That would be friendlier, but it is only safe if every code in
 * circulation was minted from an alphabet where those characters are mutually
 * exclusive. Cards from the first print run were not, so folding could map two
 * distinct real codes onto one hash. Ambiguity is solved at mint time via
 * MINT_ALPHABET instead, where it is actually safe.
 */
export function normalizePassCode(raw: string): string {
  return (raw ?? "")
    .replace(/[^a-zA-Z0-9]/g, "")
    .toLowerCase()
    .slice(0, 64);
}

/**
 * HMAC a normalized code into the hex digest stored in founder_passes.code_hash.
 *
 * SECURITY — why HMAC-with-pepper rather than a bare SHA-256:
 * the codes are short (6-8 chars). Even at 8 characters that is ~1e11
 * possibilities, which a commodity GPU walks through against a plain hash in
 * well under a minute. A bare digest column would therefore be equivalent to
 * storing the codes in plaintext the moment the table leaks — and because the
 * codes are printed on physical cards we cannot rotate them in response. The
 * pepper is an environment secret that never touches the database, so a dump
 * of founder_passes alone yields nothing usable; an attacker needs the DB and
 * the runtime environment.
 *
 * The pepper is therefore load-bearing and permanent: changing it invalidates
 * every card ever printed. Treat it like a signing key, not a config knob.
 */
export function hashPassCode(normalizedCode: string, pepper: string): string {
  if (!normalizedCode) throw new Error("hashPassCode: empty code");
  if (!pepper) {
    // Loud, not lenient. A silent fallback to an unpeppered hash would still
    // "work" — it would write hashes that the peppered path can never match,
    // bricking a whole print run in a way that only shows up at redemption.
    throw new Error(
      "hashPassCode: FOUNDER_PASS_PEPPER is not set. Refusing to hash without it — " +
        "an unpeppered hash would be both insecure and incompatible with existing rows.",
    );
  }
  return createHmac("sha256", pepper).update(normalizedCode).digest("hex");
}

/** Read the pepper from the environment, failing loudly if absent. */
export function requirePepper(): string {
  const pepper = process.env.FOUNDER_PASS_PEPPER ?? "";
  if (!pepper) {
    throw new Error(
      "FOUNDER_PASS_PEPPER is not set. Generate one with:\n" +
        "  node -e \"console.log(require('node:crypto').randomBytes(32).toString('hex'))\"\n" +
        "and set it in .env.local and in the Vercel project env. It must be identical " +
        "in both places and must never change once cards are printed.",
    );
  }
  return pepper;
}

/**
 * Mint a fresh random code from MINT_ALPHABET.
 *
 * Uses crypto randomInt rather than Math.random: these codes are bearer
 * tokens for a physical object, and a predictable PRNG would let someone who
 * saw a handful of cards derive the rest of the batch. randomInt is also
 * rejection-sampled internally, so there is no modulo bias toward the front
 * of the alphabet.
 */
export function mintPassCode(length: number = MINT_LENGTH): string {
  let out = "";
  for (let i = 0; i < length; i++) {
    out += MINT_ALPHABET[randomInt(0, MINT_ALPHABET.length)];
  }
  return out;
}

/** Render a serial the way it is embossed on the card: "#007". */
export function formatSerial(serial: number): string {
  return `#${String(serial).padStart(3, "0")}`;
}
