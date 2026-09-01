/**
 * Pure addressing logic for issuing virtual passes, shared by the form (which
 * counts what a click will mint) and the action (which mints it).
 *
 * It lives in its own module for two reasons. The first is the same one
 * app/admin/email/blast/shared.ts gives: the recipient count on the button and
 * the addresses the server sends to have to come from one parser, or the
 * button quietly lies about how many live passes you are about to create.
 *
 * The second is mechanical — actions.ts carries "use server", and every export
 * of a "use server" module must be an async server action. A synchronous
 * helper cannot live there, and re-implementing it in the client component is
 * exactly the drift this file exists to prevent.
 *
 * No imports: safe on both sides.
 */

/**
 * How a pass invite is tagged for /admin/email's delivery metrics.
 *
 * Deliberately NOT a key in `email_templates`. The invite's body is computed
 * from the grant (grantPerkLines), so an admin editing it in a mustache editor
 * could promise perks the code does not grant — the one thing
 * lib/founder-pass-tiers.ts exists to prevent. The tag exists purely so the
 * send shows up beside every other one, because a bounced invite is a live
 * serial nobody can redeem and that is exactly the failure worth spotting.
 */
export const INVITE_TEMPLATE_KEY = "founder_pass.invite";

/** The batch every self-check probe row is written under. See self-test.ts. */
export const SELFTEST_BATCH = "selftest";

/**
 * Split a textarea of addresses into a recipient list.
 *
 * Separators are newlines, commas and semicolons — NOT spaces. That matters:
 * people paste "Ada Okonkwo <ada@example.com>" straight out of a mail client,
 * and splitting on whitespace would turn one recipient into the three tokens
 * "Ada", "Okonkwo" and the address. Within a chunk the display name is
 * stripped by preferring the angle-bracketed part, falling back to the last
 * whitespace-separated token (which handles "Ada Okonkwo ada@example.com").
 *
 * What it deliberately does NOT do is silently drop anything that fails to
 * look like an address. A chunk that survives as "bobexample.com" is passed
 * through so the action's validation can name it back to the admin. Quietly
 * discarding a malformed address would mean sending four passes when the box
 * listed five, and the missing person would never be mentioned.
 *
 * Duplicates are KEPT on purpose: sending one inbox three passes to hand out
 * is a real use, and collapsing them would mint fewer passes than the button
 * promised.
 */
export function parseEmailList(raw: string): string[] {
  return (raw ?? "")
    .split(/[\n,;]+/)
    .map((chunk) => {
      const angled = /<([^>]*)>/.exec(chunk);
      const candidate = angled
        ? angled[1]
        : (chunk.trim().split(/\s+/).pop() ?? "");
      return candidate.trim().toLowerCase();
    })
    .filter(Boolean);
}
