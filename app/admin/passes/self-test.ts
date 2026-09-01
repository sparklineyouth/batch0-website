"use server";
import { assertPermission } from "@/lib/server-guards";
import { createAdminClient } from "@/lib/supabase/admin";
import { logAudit } from "@/lib/audit";
import { env } from "@/lib/env";
import { transportStatus } from "@/lib/email/send";
import { Templates, passRedeemUrl } from "@/lib/email/templates";
import {
  hashPassCode,
  mintPassCode,
  normalizePassCode,
  requirePepper,
} from "@/lib/founder-pass-code";
import {
  getPassForUser,
  passDiscountCentsForUser,
  redeemPass,
} from "@/lib/founder-pass";
import {
  DEFAULT_TIER,
  PASS_TIERS,
  formatCents,
  grantDiscountCents,
  grantOf,
  grantPerkLines,
  parseDollarsToCents,
  passTier,
} from "@/lib/founder-pass-tiers";
import { getRegionalPrice } from "@/lib/pricing";
import { SELFTEST_BATCH } from "./shared";

/**
 * The virtual-pass self-check: does the whole chain actually work, right now,
 * in THIS environment?
 *
 * Why this exists at all. Issuing a virtual pass touches six things that fail
 * independently and mostly fail silently: an environment secret
 * (FOUNDER_PASS_PEPPER), a mail transport chosen in the database rather than
 * the environment, three migrations that this repo applies by hand, a check
 * constraint that has to agree with a TypeScript array, an HMAC round trip,
 * and a conditional UPDATE carrying the one-pass-per-account rule. The only
 * previous way to learn that one of them was broken was to email a real person
 * a real code and watch what happened — and by then a serial is spent, the
 * message cannot be recalled, and half the failures still look like "nothing
 * happened".
 *
 * So this runs the real code paths — the real hasher, the real redeemPass(),
 * the real template — and reports each link in the chain by name.
 *
 * WHAT IT COSTS: nothing permanent, by construction.
 *
 *   * Probe rows take NEGATIVE serials. Every real pass is positive, serial is
 *     unique, and nextBatchDefaults() reads the MAXIMUM — so a probe can never
 *     collide with a card in someone's wallet and can never push the next real
 *     serial forward. The sequence a holder's number comes from is untouched.
 *
 *   * Probe rows are DELETED, not revoked. Revoke-never-delete is the rule for
 *     real passes because the row is the only record that a numbered object
 *     exists in the world (see migration 0039). A negative-serial probe records
 *     nothing: no card was printed, no email was sent, nobody was promised
 *     anything. Keeping it would be litter in the ledger, not an audit trail.
 *
 *   * The redemption step really does bind a probe to the runner's own account
 *     for a moment, because that is the only way to exercise the partial unique
 *     index and the conditional UPDATE that enforce one-pass-per-account. It is
 *     unbound and deleted in a finally block, and every run purges strays from
 *     any earlier run before it starts, so a crashed run self-heals on the next
 *     click rather than leaving someone holding a phantom pass.
 *
 *   * The rate-limit slots redeemPass() consumes are handed back at the end.
 *     Otherwise three self-checks would lock the runner out of redeeming a real
 *     pass for an hour, and a diagnostic that breaks the thing it diagnoses is
 *     worse than no diagnostic.
 *
 * NO EMAIL IS SENT. Delivery is the one link that cannot be tested without
 * consequences, so the check verifies everything up to the mail server —
 * transport reachability, the rendered message, the link inside it — and the
 * panel's "send one to myself" button covers the last hop deliberately.
 */

/** One link in the chain, as the panel prints it. */
export type CheckStep = {
  key: string;
  label: string;
  status: "pass" | "fail" | "skip";
  /** What was actually observed — a number, an error, a reason for skipping. */
  detail: string;
};

export type SelfCheckResult = {
  /** False if any step failed. Skips are not failures. */
  ok: boolean;
  steps: CheckStep[];
  /** Probe rows left behind by an earlier crashed run, cleared on the way in. */
  strays: number;
  /** True if every probe row this run created is gone. */
  clean: boolean;
};

/**
 * Where probe serials start.
 *
 * Below the lowest serial in the table and never above -1, so a run is
 * disjoint from real passes AND from a concurrent run's probes (which would
 * have taken the same floor and moved it down before this one read it — the
 * unique index catches the remaining overlap and the step fails honestly
 * rather than corrupting anything).
 */
async function probeSerialBase(
  admin: ReturnType<typeof createAdminClient>,
): Promise<number> {
  const { data } = await admin
    .from("founder_passes")
    .select("serial")
    .order("serial", { ascending: true })
    .limit(1)
    .maybeSingle();
  const min = (data as { serial: number } | null)?.serial ?? 0;
  return Math.min(-1, min - 1);
}

/** Delete every probe row. Returns how many there were. */
async function purgeProbes(
  admin: ReturnType<typeof createAdminClient>,
): Promise<number> {
  const { data } = await admin
    .from("founder_passes")
    .delete()
    .eq("batch", SELFTEST_BATCH)
    .select("serial");
  return ((data ?? []) as unknown[]).length;
}

/**
 * Hand back the redemption attempts this run spent.
 *
 * The key format mirrors checkRateLimit's `${kind}:${identifier}` exactly. If
 * that ever drifts this becomes a no-op — the check still passes, the runner
 * just keeps a smaller quota for an hour, which is the harmless direction.
 */
async function refundRedeemAttempts(
  admin: ReturnType<typeof createAdminClient>,
  userId: string,
): Promise<void> {
  await admin
    .from("rate_limits")
    .delete()
    .eq("key", `founder-pass-redeem:${userId}`);
}

function pass(key: string, label: string, detail: string): CheckStep {
  return { key, label, status: "pass", detail };
}
function fail(key: string, label: string, detail: string): CheckStep {
  return { key, label, status: "fail", detail };
}
function skip(key: string, label: string, detail: string): CheckStep {
  return { key, label, status: "skip", detail };
}

/** The tuition a discount is resolved against, for the arithmetic step. */
async function samplePriceCents(
  admin: ReturnType<typeof createAdminClient>,
): Promise<{ cents: number; source: string }> {
  const { data } = await admin
    .from("cohorts")
    .select("name, price_cents")
    .in("status", ["upcoming", "active"])
    .order("starts_on", { ascending: true, nullsFirst: false })
    .limit(1)
    .maybeSingle();
  const row = data as { name: string | null; price_cents: number | null } | null;
  // Same fallback the accepted page uses, so a site with no live cohort still
  // reports a number an admin recognises rather than $0.
  if (!row?.price_cents) return { cents: 13000, source: "default tuition" };
  return { cents: row.price_cents, source: row.name ?? "the live cohort" };
}

/**
 * Run the whole chain and report it step by step.
 *
 * `tier` and `discountDollars` are the terms to test with — the same two
 * inputs the send form takes — so an admin about to hand out a $45-off
 * founding pass can confirm that exact grant resolves to the exact number they
 * intend before anybody receives one.
 */
export async function runVirtualPassSelfCheckAction(input: {
  tier?: string;
  discountDollars?: string;
}): Promise<SelfCheckResult> {
  const { userId } = await assertPermission("passes.manage");
  const admin = createAdminClient();

  const steps: CheckStep[] = [];
  const tier = passTier(input.tier);
  const discountCents = parseDollarsToCents(input.discountDollars ?? "");
  const grant = grantOf(tier, discountCents, "virtual");

  // Clear anything a previous crashed run left behind, before this one adds to
  // it. Reported rather than swallowed: strays are how you find out a run died
  // halfway, and that is worth saying out loud.
  const strays = await purgeProbes(admin);

  let redeemed = false;
  try {
    // ---------------------------------------------------------------- 1. env
    let pepper = "";
    try {
      pepper = requirePepper();
      steps.push(
        pass(
          "pepper",
          "FOUNDER_PASS_PEPPER is set",
          `${pepper.length} characters. Every code ever issued hashes under this exact value — it must never change.`,
        ),
      );
    } catch (err) {
      steps.push(
        fail(
          "pepper",
          "FOUNDER_PASS_PEPPER is set",
          err instanceof Error ? err.message : "Not set in this environment.",
        ),
      );
      // Nothing below can run without it: hashing refuses, so there is no code
      // to insert and no row to redeem. Stop here rather than printing eight
      // more failures that all say the same thing.
      return { ok: false, steps, strays, clean: true };
    }

    // ------------------------------------------------------------ 2. mailer
    const transport = await transportStatus();
    steps.push(
      transport.ok
        ? pass("transport", "Email can leave the building", transport.detail)
        : fail(
            "transport",
            "Email can leave the building",
            `${transport.detail} Passes can still be issued, but the send would fail and each one would be revoked on the spot.`,
          ),
    );

    // ----------------------------------------------------------- 3. site URL
    const httpsInProd =
      process.env.NODE_ENV !== "production" || env.siteUrl.startsWith("https://");
    steps.push(
      env.siteUrl && httpsInProd
        ? pass(
            "site_url",
            "Redeem links point somewhere real",
            `${env.siteUrl}/pass — this is the origin baked into every invite.`,
          )
        : fail(
            "site_url",
            "Redeem links point somewhere real",
            `NEXT_PUBLIC_SITE_URL is "${env.siteUrl}". Every invite's button is built from it, so a wrong value sends recipients to the wrong site.`,
          ),
    );

    // ------------------------------------------------------------- 4. schema
    const { error: columnError } = await admin
      .from("founder_passes")
      .select("kind, issued_to_email, issued_at, tier, recipient_name, discount_cents")
      .limit(1);
    if (columnError) {
      steps.push(
        fail(
          "schema",
          "Migrations 0054–0056 are applied",
          `${columnError.message} — run 0054_virtual_founder_passes.sql, 0055_founder_pass_tiers.sql and 0056_founder_pass_custom_discount.sql.`,
        ),
      );
      return { ok: false, steps, strays, clean: true };
    }
    steps.push(
      pass(
        "schema",
        "Migrations 0054–0056 are applied",
        "kind, issued_to_email, issued_at, tier, recipient_name and discount_cents all exist.",
      ),
    );

    // ------------------------------------------- 5. probe rows, one per tier
    //
    // This doubles as the check that PASS_TIERS and the 0055 check constraint
    // still agree. A tier added to the array but not to the constraint fails
    // every insert of that tier — at send time, after the admin has chosen it
    // and named a recipient — so proving it here is the point.
    const base = await probeSerialBase(admin);
    const probes = PASS_TIERS.map((t, i) => {
      const code = normalizePassCode(mintPassCode());
      return { tier: t, code, serial: base - i };
    });
    // One more carrying the terms actually being tested, so the readback below
    // proves THIS grant resolves, not just a bare standard one.
    const subject = {
      tier,
      code: normalizePassCode(mintPassCode()),
      serial: base - probes.length,
    };

    const { error: insertError } = await admin.from("founder_passes").insert(
      [...probes, subject].map((p, i) => ({
        serial: p.serial,
        code_hash: hashPassCode(p.code, pepper),
        batch: SELFTEST_BATCH,
        kind: "virtual",
        issued_to_email: null,
        issued_at: new Date().toISOString(),
        note: "Self-check probe. Deleted automatically; safe to delete by hand.",
        tier: p.tier.key,
        // Only the subject row carries the override — the roster rows exist to
        // test the tier vocabulary, and giving them a discount would prove
        // nothing extra.
        discount_cents: i === probes.length ? discountCents : null,
        recipient_name: null,
      })),
    );
    if (insertError) {
      steps.push(
        fail(
          "tiers",
          "Every tier is writable",
          `${insertError.message} — PASS_TIERS in lib/founder-pass-tiers.ts and the founder_passes_tier_check constraint in migration 0055 have to list the same keys.`,
        ),
      );
      // The finally block below purges whatever did land before the failure.
      return { ok: false, steps, strays, clean: true };
    }
    steps.push(
      pass(
        "tiers",
        "Every tier is writable",
        `${PASS_TIERS.map((t) => t.key).join(", ")} — all accepted by the 0055 check constraint.`,
      ),
    );

    // ------------------------------------------------- 6. the HMAC round trip
    const subjectHash = hashPassCode(subject.code, pepper);
    const { data: found } = await admin
      .from("founder_passes")
      .select("serial, tier, discount_cents")
      .eq("code_hash", subjectHash)
      .maybeSingle();
    const foundRow = found as
      | { serial: number; tier: string | null; discount_cents: number | null }
      | null;
    steps.push(
      foundRow?.serial === subject.serial
        ? pass(
            "hash",
            "A minted code finds its own row",
            `Minted, hashed and looked back up. The pepper in this environment matches the hashes it writes.`,
          )
        : fail(
            "hash",
            "A minted code finds its own row",
            "The code just written could not be found by its own hash. The hasher and the reader disagree — nothing would ever redeem.",
          ),
    );

    // -------------------------------------------- 7. what the grant is worth
    const price = await samplePriceCents(admin);
    const usd = grantDiscountCents(grant, price.cents);
    // A regional price the overrides table actually carries, so "full ride
    // waives the regional amount, not the list price" is demonstrated rather
    // than asserted.
    const regional = getRegionalPrice(price.cents, "IN");
    const regionalOff = grantDiscountCents(grant, regional.amountCents);
    steps.push(
      pass(
        "math",
        "The discount resolves to a real number",
        `Against ${formatCents(price.cents)} (${price.source}): ${formatCents(usd)} off, ` +
          `so ${formatCents(Math.max(0, price.cents - usd))} is charged. ` +
          `Against the ${formatCents(regional.amountCents)} regional price: ${formatCents(regionalOff)} off, ` +
          `leaving ${formatCents(Math.max(0, regional.amountCents - regionalOff))} — never a refund.`,
      ),
    );

    // The terms in the database have to be the terms that were chosen. This is
    // the one thing a send can get wrong silently and permanently.
    const storedTier = passTier(foundRow?.tier);
    const storedDiscount = foundRow?.discount_cents ?? null;
    steps.push(
      storedTier.key === tier.key && storedDiscount === discountCents
        ? pass(
            "stamp",
            "The terms are stamped on the row",
            `Stored as tier "${storedTier.key}" with ${
              storedDiscount === null ? "no override" : `an override of ${formatCents(storedDiscount)}`
            } — the same terms picked above.`,
          )
        : fail(
            "stamp",
            "The terms are stamped on the row",
            `Chose ${tier.key}/${discountCents === null ? "tier" : discountCents}, read back ${storedTier.key}/${storedDiscount ?? "tier"}.`,
          ),
    );

    // ------------------------------------------------------- 8. the email
    const rendered = Templates.founderPassInvite({
      code: subject.code,
      serial: subject.serial,
      tierLabel: tier.label,
      perkLines: grantPerkLines(grant),
      isStandard: tier.key === DEFAULT_TIER.key && discountCents === null,
      recipientName: "Self Check",
      note: null,
    });
    const link = passRedeemUrl(subject.code);
    const emailOk =
      rendered.html.includes(subject.code.toUpperCase()) &&
      rendered.html.includes(link) &&
      rendered.text.includes(link) &&
      rendered.subject.length > 0;
    steps.push(
      emailOk
        ? pass(
            "email",
            "The invite renders with a working link",
            `Subject "${rendered.subject}". The code appears on the card, and both the HTML button and the plain-text copy point at ${env.siteUrl}/pass?code=…`,
          )
        : fail(
            "email",
            "The invite renders with a working link",
            "The rendered message is missing the code or the redeem link. Recipients would get an invite they cannot act on.",
          ),
    );

    // --------------------------------------------------- 9. real redemption
    //
    // The real redeemPass(), against the real row, bound to the runner's own
    // account — the only way to exercise the conditional UPDATE and the
    // one-pass-per-account index rather than a re-implementation of them.
    // Start the redemption steps from a clean quota. A run spends three of the
    // five hourly attempts, so two runs back to back would otherwise trip the
    // limiter and report a working redemption path as broken — a diagnostic
    // that fails because you ran it twice is worse than none. Refunded again in
    // the finally block, so the runner ends with everything they started with.
    await refundRedeemAttempts(admin, userId);

    const heldAlready = await getPassForUser(admin, userId);
    if (heldAlready) {
      // Holding a pass is not a broken environment, and the correct behaviour
      // in that case is itself worth asserting: the index must refuse a second
      // one. So this is a real check, not a shrug.
      const refused = await redeemPass(admin, {
        userId,
        rawCode: subject.code,
        ip: null,
      });
      steps.push(
        !refused.ok && refused.reason === "already_have_pass"
          ? pass(
              "redeem",
              "One pass per account holds",
              `You already hold pass #${heldAlready.serial}, and a second code was correctly refused. The full redemption path was skipped so your own pass is untouched.`,
            )
          : fail(
              "redeem",
              "One pass per account holds",
              `You hold pass #${heldAlready.serial}, but a second code came back as ${
                refused.ok ? "redeemed" : refused.reason
              }. The partial unique index from migration 0039 is not doing its job.`,
            ),
      );
      if (refused.ok) redeemed = true;
      steps.push(
        skip(
          "readback",
          "A redeemed pass reads back with its terms",
          "Skipped — running it would bind a probe to your account, and you already hold a real pass. Run this from an account without one to cover it.",
        ),
      );
    } else {
      const claim = await redeemPass(admin, {
        userId,
        rawCode: subject.code,
        ip: null,
      });
      redeemed = claim.ok;
      steps.push(
        claim.ok && claim.serial === subject.serial
          ? pass(
              "redeem",
              "The code redeems",
              `Claimed probe #${subject.serial} through the same conditional UPDATE a real holder hits.`,
            )
          : fail(
              "redeem",
              "The code redeems",
              claim.ok
                ? `Claimed the wrong row (#${claim.serial} instead of #${subject.serial}).`
                : `Refused with "${claim.reason}".`,
            ),
      );

      if (claim.ok) {
        // What the holder will actually see, and what checkout will actually
        // charge — read through the same functions those surfaces use.
        const readBack = await getPassForUser(admin, userId);
        const charged = await passDiscountCentsForUser(admin, userId, price.cents);
        const expected = grantDiscountCents(grant, price.cents);
        steps.push(
          readBack &&
            readBack.grant.tier.key === tier.key &&
            readBack.grant.discountCents === discountCents &&
            charged === expected
            ? pass(
                "readback",
                "A redeemed pass reads back with its terms",
                `Reads as ${readBack.grant.tier.label.toLowerCase()}, and checkout would take ${formatCents(charged)} off. ` +
                  `The holder's page prints: ${grantPerkLines(readBack.grant)[0]}`,
              )
            : fail(
                "readback",
                "A redeemed pass reads back with its terms",
                readBack
                  ? `Read back as ${readBack.grant.tier.key}/${readBack.grant.discountCents ?? "tier"} charging ${formatCents(charged)}, expected ${tier.key}/${discountCents ?? "tier"} charging ${formatCents(expected)}.`
                  : "The pass could not be read back at all immediately after redeeming it.",
              ),
        );

        // A code is one-shot. Replaying it is the single most likely way a
        // pass gets handed to two people.
        const replay = await redeemPass(admin, {
          userId,
          rawCode: subject.code,
          ip: null,
        });
        steps.push(
          !replay.ok &&
            (replay.reason === "already_redeemed" ||
              replay.reason === "already_have_pass")
            ? pass(
                "replay",
                "A claimed code cannot be claimed twice",
                `Replaying it came back "${replay.reason}", as it must.`,
              )
            : fail(
                "replay",
                "A claimed code cannot be claimed twice",
                replay.ok
                  ? "The same code redeemed a second time. One card could be claimed by two accounts."
                  : `Refused, but with "${replay.reason}" rather than a claimed/held reason.`,
              ),
        );
      }
    }

    // ------------------------------------------------------- 10. revocation
    //
    // Revoke kills a code — the answer to a leaked list and to a lost pass, so
    // it has to actually stop a redemption rather than only grey out a row.
    const victim = probes[0];
    await admin
      .from("founder_passes")
      .update({ revoked_at: new Date().toISOString() })
      .eq("serial", victim.serial);
    const afterRevoke = await redeemPass(admin, {
      userId,
      rawCode: victim.code,
      ip: null,
    });
    steps.push(
      !afterRevoke.ok && afterRevoke.reason === "revoked"
        ? pass(
            "revoke",
            "Revoking a pass kills its code",
            'A revoked probe refused redemption with "revoked" — a leaked batch really can be switched off.',
          )
        : fail(
            "revoke",
            "Revoking a pass kills its code",
            afterRevoke.ok
              ? "A revoked pass still redeemed. Revoke does not protect anything."
              : `Refused with "${afterRevoke.reason}" rather than "revoked" — the reason a holder is shown would be wrong.`,
          ),
    );
  } catch (err) {
    steps.push(
      fail(
        "unexpected",
        "The check ran to completion",
        err instanceof Error ? err.message : String(err),
      ),
    );
  } finally {
    // Unconditional. Every path out of here — success, a failed assertion, a
    // thrown error — leaves the table exactly as it found it.
    await purgeProbes(admin);
    await refundRedeemAttempts(admin, userId);
  }

  const remaining = await purgeProbes(admin);
  const clean = remaining === 0;
  if (!clean) {
    steps.push(
      fail(
        "cleanup",
        "Nothing is left behind",
        `${remaining} probe row(s) could not be deleted. Remove them with: delete from founder_passes where batch = '${SELFTEST_BATCH}';`,
      ),
    );
  } else {
    steps.push(
      pass(
        "cleanup",
        "Nothing is left behind",
        `Every probe row deleted${redeemed ? ", your account unbound" : ""}, redemption attempts refunded, and no real serial consumed.`,
      ),
    );
  }

  const ok = steps.every((s) => s.status !== "fail");
  await logAudit({
    action: "founder_pass.self_check",
    targetType: "founder_pass_batch",
    targetId: SELFTEST_BATCH,
    payload: {
      ok,
      tier: tier.key,
      discount_cents: discountCents,
      strays_cleared: strays,
      failed: steps.filter((s) => s.status === "fail").map((s) => s.key),
    },
  });

  return { ok, steps, strays, clean };
}

export type InvitePreview = {
  subject: string;
  html: string;
  text: string;
  redeemUrl: string;
  code: string;
};

/**
 * Render the invite exactly as it would be sent, without sending it.
 *
 * The message is the product here — it carries the promises, the card, and the
 * only link the recipient will ever click — and until now the only way to see
 * one was to email it to somebody. The code in it is minted fresh and stored
 * nowhere, so the preview is a real render of a dead code: it will never
 * redeem, and nothing about showing it is sensitive.
 */
export async function previewInviteEmailAction(input: {
  tier?: string;
  discountDollars?: string;
  recipientName?: string;
  note?: string;
}): Promise<InvitePreview> {
  await assertPermission("passes.manage");

  const tier = passTier(input.tier);
  const discountCents = parseDollarsToCents(input.discountDollars ?? "");
  const grant = grantOf(tier, discountCents, "virtual");
  const code = normalizePassCode(mintPassCode());

  const t = Templates.founderPassInvite({
    code,
    serial: 0,
    tierLabel: tier.label,
    perkLines: grantPerkLines(grant),
    isStandard: tier.key === DEFAULT_TIER.key && discountCents === null,
    recipientName: (input.recipientName ?? "").trim() || null,
    note: (input.note ?? "").trim() || null,
  });

  return {
    subject: t.subject,
    html: t.html,
    text: t.text,
    redeemUrl: passRedeemUrl(code),
    code: code.toUpperCase(),
  };
}

/**
 * Delete any probe rows left over from a crashed self-check.
 *
 * The self-check already does this on the way in and the way out; this is the
 * button for the case where it died so badly it did neither, and for anyone
 * who wants to confirm the table is clean without running the check again.
 */
export async function cleanupSelfTestPassesAction(): Promise<{
  ok: true;
  removed: number;
  message: string;
}> {
  await assertPermission("passes.manage");
  const admin = createAdminClient();
  const removed = await purgeProbes(admin);
  if (removed > 0) {
    await logAudit({
      action: "founder_pass.self_check_cleanup",
      targetType: "founder_pass_batch",
      targetId: SELFTEST_BATCH,
      payload: { removed },
    });
  }
  return {
    ok: true,
    removed,
    message:
      removed === 0
        ? "Nothing to clean up — no probe rows left behind."
        : `Deleted ${removed} leftover probe row(s). No real pass is affected: probes take negative serials and are never issued to anyone.`,
  };
}
