import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth";
import { settleCheckoutSession } from "@/lib/settle-checkout";
import { LocalTime } from "@/components/ui/local-time";
import { StatusBadge } from "@/components/ui/card";
import { ChargePayButton } from "@/components/charge-pay-button";
import { PortalButton } from "@/app/dashboard/billing/portal-button";
import {
  AppHeader,
  AppBody,
  Section,
  Row,
  Stat,
  Empty,
  Alert,
} from "@/components/app/frame";
import { DotRail, Ring, type RailCell } from "@/components/app/viz";

export const metadata = { title: "Billing · batch0" };
export const dynamic = "force-dynamic";

/**
 * Money, on a phone.
 *
 * The destination this replaces is two taps from the More tab and is a
 * `<table className="w-full min-w-[520px]">` inside an `overflow-x-auto`. That
 * hardcoded floor forces 130px of sideways scrolling at 390px and 200px at
 * 320px to reach the Status column — on the page that answers "do I owe
 * anything", which is the only billing question a student asks from a phone.
 *
 * So the table is gone entirely and nothing replaced it row-for-row. The
 * answer is three tiles and a rail; the receipts are rows you tap into, each
 * one going straight to the Stripe-hosted receipt rather than to a Downloads
 * column that had to be scrolled to.
 *
 * Paying returns here rather than to the desktop table. The checkout route
 * takes a `returnTo` key and resolves it against a two-entry allowlist — a key
 * rather than a path because that value comes back as a redirect into our own
 * origin, where anything caller-supplied is an open redirect. That makes this
 * screen the arrival point, so it settles the session itself: the webhook is
 * authoritative but can land seconds later, and without this the student who
 * just paid sees the charge still listed as owed.
 */

/**
 * Whole dollars when the cents are zero.
 *
 * Stat's value box is `clamp(1.5rem, 7.5vw, 2.125rem)` of a ~0.6em mono face,
 * and its own comment records that six glyphs ("$1,500") is the budget at
 * 320px. "$4,500.00" is nine and would collide with the neighbouring tile,
 * which `body { overflow-x: clip }` would hide rather than scroll. Every
 * amount this product charges is a whole number of dollars, so the fraction
 * digits are pure width.
 */
function money(cents: number, currency = "usd") {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
  }).format(cents / 100);
}

/** A payment and a fee/fine, reduced to the one shape this screen renders. */
type Item = {
  id: string;
  date: string;
  label: string;
  amountCents: number;
  currency: string;
  status: string;
  receiptUrl: string | null;
};

// Money that arrived (or was written off). `waived` is settled but is NOT paid
// — the two sets differ on purpose, and the "Paid" tile uses the narrower one.
const SETTLED = new Set(["succeeded", "paid", "waived"]);
const PAID = new Set(["succeeded", "paid"]);
// Settled or not, these are the only statuses that represent an obligation
// with an outcome, so they are the only ones the rail can score. A `refunded`
// payment did settle and then reversed, and a `cancelled` charge was never
// owed — drawing either as a missed square would be a lie about the student.
const SCOREABLE = new Set(["succeeded", "paid", "waived", "pending", "failed"]);

export default async function StudentAppBilling({
  searchParams,
}: {
  searchParams: {
    charge_paid?: string;
    charge_canceled?: string;
    session_id?: string;
  };
}) {
  const user = await requireUser();
  // Settle BEFORE the ledger reads below, not in parallel with them. Stripe
  // redirects here the instant checkout completes, often ahead of the webhook,
  // and a Promise.all would race the write against its own read — the student
  // would land on "You owe $X" for the charge they just paid, then have to
  // refresh. It is a no-op without a session_id.
  const settled = await settleCheckoutSession(searchParams.session_id, user.id);
  // RLS-scoped, matching the desktop page: every row here belongs to the
  // reader and both tables carry a user_id policy, so there is nothing for the
  // service role to buy.
  const supabase = createClient();

  const [{ data: payments }, { data: charges }, { data: profile }] =
    await Promise.all([
      supabase
        .from("payments")
        .select("id, created_at, amount_cents, currency, status, stripe_receipt_url")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false }),
      supabase
        .from("user_charges")
        .select(
          "id, created_at, kind, description, amount_cents, status, stripe_receipt_url",
        )
        .eq("user_id", user.id)
        .order("created_at", { ascending: false }),
      supabase
        .from("profiles")
        .select("stripe_customer_id")
        .eq("id", user.id)
        .maybeSingle(),
    ]);

  const pendingCharges = (charges ?? []).filter(
    (c) => (c.status as string) === "pending",
  );

  // Newest first, which is the order the rows want; the rail reverses it.
  const items: Item[] = [
    ...(payments ?? []).map((p) => ({
      id: `payment-${p.id as string}`,
      date: p.created_at as string,
      label: "Cohort enrollment",
      amountCents: p.amount_cents as number,
      currency: (p.currency as string) ?? "usd",
      status: p.status as string,
      receiptUrl: (p.stripe_receipt_url as string | null) ?? null,
    })),
    ...(charges ?? [])
      // A cancelled charge was withdrawn before anyone paid it. It is not
      // history the student needs and it is not money — it only makes the
      // list longer.
      .filter((c) => (c.status as string) !== "cancelled")
      .map((c) => ({
        id: `charge-${c.id as string}`,
        date: c.created_at as string,
        label: `${c.kind === "fine" ? "Fine" : "Fee"}: ${c.description as string}`,
        amountCents: c.amount_cents as number,
        currency: "usd",
        status: c.status as string,
        receiptUrl: (c.stripe_receipt_url as string | null) ?? null,
      })),
  ].sort((a, b) => b.date.localeCompare(a.date));

  const dueCents = pendingCharges.reduce(
    (sum, c) => sum + (c.amount_cents as number),
    0,
  );
  // Deliberately not "every row's amount". A pending Stripe session and a
  // waived fine both sit in `items` and neither one is money the student paid.
  const paidItems = items.filter((i) => PAID.has(i.status));
  const paidCents = paidItems.reduce((sum, i) => sum + i.amountCents, 0);

  const scoreable = items.filter((i) => SCOREABLE.has(i.status));
  const settledCount = scoreable.filter((i) => SETTLED.has(i.status)).length;

  // Oldest → newest, one cell per obligation. There is no axis to reconstruct
  // here: unlike a weekly cadence, where a `.gte()` query returns rows only for
  // the weeks that HAVE data and the absent ones have to be generated from the
  // calendar, the cells ARE the rows — an unpaid charge exists in the table, so
  // nothing can be silently missing from this window.
  const cells: RailCell[] = [...scoreable].reverse().map((i) => ({
    key: i.id,
    // UTC, matching lib/week.ts's axis ticks. This string only ever appears in
    // the rail's accessible summary ("missed Aug 12"); the visible dates below
    // go through <LocalTime>, which is the rule for anything a reader reads.
    label: new Date(i.date).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    }),
    state: SETTLED.has(i.status) ? "hit" : "miss",
  }));

  const history = items.filter((i) => i.status !== "pending");
  // Almost always false, and that is not a bug worth removing the branch over.
  // app/app/(student)/layout.tsx redirects anyone with a pending fine to
  // /dashboard/pay-fine before this page renders, so an ordinary student never
  // sees a fine here — the only viewer who can is a full admin, who bypasses
  // that redirect so they can go waive the thing they are looking at. Keeping
  // the sentence means the one person who reaches this state still reads why
  // the rest of the product is locked; dropping it would leave them a bare
  // amount with no explanation.
  const hasFine = pendingCharges.some((c) => (c.kind as string) === "fine");

  return (
    <>
      <AppHeader
        title="Billing"
        eyebrow={dueCents > 0 ? "Something is due" : "Nothing outstanding"}
      />
      <AppBody>
        {/* The outcome of the trip to Stripe, before anything else on the
            screen. `settled` is the source of truth rather than the
            `charge_paid` flag: the flag only says Stripe redirected as a
            success, while `settled` means we actually reconciled the session.
            Announcing a payment we have not confirmed is the one wrong thing
            to say here. The cancel case is deliberately quiet — backing out of
            checkout is not an error and the amount due below already says
            where things stand. */}
        {settled && (
          <div className="mb-5">
            <Alert tone="good" title="Payment received">
              Your account is up to date. A receipt is on the row below.
            </Alert>
          </div>
        )}
        {searchParams.charge_paid && !settled && (
          <div className="mb-5">
            <Alert tone="info" title="Payment is processing">
              Stripe has it. This page will show it as settled once the
              confirmation lands — usually within a minute.
            </Alert>
          </div>
        )}
        {dueCents > 0 && (
          <Alert
            tone="warn"
            title={`${money(dueCents)} due`}
            // No pay button here: with more than one outstanding charge a
            // single button could only guess which to open, and each charge is
            // its own Stripe session. The buttons live on the rows below,
            // beside the thing they are paying for.
          >
            {pendingCharges.length === 1
              ? (pendingCharges[0].description as string)
              : `${pendingCharges.length} charges outstanding.`}
            {hasFine &&
              " A fine keeps the rest of batch0 locked until it's settled."}
          </Alert>
        )}

        <Section title="Your account">
          <div className="grid grid-cols-2 gap-2.5">
            <Stat
              label="Due now"
              value={money(dueCents)}
              tone={dueCents > 0 ? "warn" : "default"}
              hint={dueCents > 0 ? "Payable below" : "You're square"}
            />
            <Stat
              label="Paid"
              value={money(paidCents)}
              // "payments", not "settled". The tile beside this one is called
              // Settled and counts a wider set (a waived fine settles without
              // anyone paying), and two adjacent tiles using the same word for
              // two different sets is how a reader concludes the numbers
              // disagree.
              hint={`${paidItems.length} payment${paidItems.length === 1 ? "" : "s"}`}
            />
            <Stat
              label="Settled"
              span
              // The ring prints its own figure, so this is only rendered when
              // there is no ring — and with nothing charged yet the ratio is
              // "0/0", which reads as a broken counter rather than as an empty
              // account. An em dash plus the hint below says it properly.
              value={scoreable.length > 0 ? `${settledCount}/${scoreable.length}` : "—"}
              graphic={
                scoreable.length > 0 ? (
                  <Ring
                    label="Charges settled"
                    value={settledCount}
                    max={scoreable.length}
                    tone={settledCount === scoreable.length ? "good" : "warn"}
                  />
                ) : undefined
              }
              hint={
                scoreable.length === 0
                  ? "Nothing has been charged yet"
                  : `${settledCount} of ${scoreable.length} charges cleared`
              }
            />
          </div>
        </Section>

        {pendingCharges.length > 0 && (
          <Section title="Outstanding">
            {/* No `href` on these rows on purpose. A row that both navigates
                and carries a payment button is a mis-tap that opens Stripe;
                the only thing to do with an unpaid charge is pay it. */}
            <div className="rounded-2xl border border-line px-4 sm:px-5">
              {pendingCharges.map((c) => (
                <Row
                  key={c.id as string}
                  label={c.description as string}
                  value={`${c.kind === "fine" ? "Fine" : "Fee"} · ${money(
                    c.amount_cents as number,
                  )}`}
                  meta={<LocalTime value={c.created_at as string} mode="date" />}
                  right={
                    // ChargePayButton is a shared control at Button size="sm",
                    // which is 32px — below this app's 44px touch floor. Raised
                    // from the outside rather than by editing a button four
                    // desktop pages also render, the same way AppHeader states
                    // its size contract on the wrapper.
                    <div className="shrink-0 [&_button]:h-11 [&_button]:px-4 [&_button]:text-[13px]">
                      <ChargePayButton chargeId={c.id as string} returnTo="app" />
                    </div>
                  }
                />
              ))}
            </div>
          </Section>
        )}

        <Section title="History">
          {history.length === 0 ? (
            // Two sentences, because "nothing has been charged to you yet"
            // directly under an Outstanding section listing a charge is a
            // contradiction the reader has to resolve. History is what has
            // *finished*, and with only a pending charge nothing has.
            <Empty>
              {pendingCharges.length > 0
                ? "Nothing has settled yet — the charge above is the first."
                : "Nothing has been charged to you yet."}
            </Empty>
          ) : (
            <>
              <DotRail
                label="Charges settled"
                cells={cells}
                tone={settledCount === scoreable.length ? "good" : "warn"}
                caption="Oldest to newest · a filled square is settled"
              />
              <div className="mt-5 rounded-2xl border border-line px-4 sm:px-5">
                {history.map((i) => (
                  <Row
                    key={i.id}
                    label={i.label}
                    meta={<LocalTime value={i.date} mode="date" />}
                    // Straight to the Stripe-hosted receipt. This is what
                    // retires the receipts table: the download was a column you
                    // had to scroll sideways to reach, and here it is the row.
                    href={i.receiptUrl ?? undefined}
                    external={!!i.receiptUrl}
                    muted={!SETTLED.has(i.status)}
                    // The badge goes below the label, not beside the amount:
                    // "REFUNDED" plus a figure in the right slot leaves ~100px
                    // for the description at 320px, and the description is the
                    // part that identifies the row.
                    below={
                      i.status === "succeeded" || i.status === "paid" ? undefined : (
                        <StatusBadge status={i.status} />
                      )
                    }
                    right={
                      <span className="shrink-0 font-mono text-[13px] tabular-nums text-ink-soft">
                        {money(i.amountCents, i.currency)}
                      </span>
                    }
                  />
                ))}
              </div>
              <p className="mt-2.5 text-[11px] leading-relaxed text-ink-faint">
                Tap a row with a receipt to open it on Stripe.
              </p>
            </>
          )}
        </Section>

        {profile?.stripe_customer_id && (
          <Section title="Payment method">
            <div className="rounded-2xl border border-line bg-wash px-5 py-4">
              <p className="text-[13.5px] leading-relaxed text-ink-soft">
                Cards, past invoices and billing details live in Stripe&apos;s
                own portal.
              </p>
              {/* Same 44px lift as the pay buttons above; PortalButton also
                  ships at Button size="sm". `items-stretch` overrides its
                  `items-end`, so the control is full-width and unmissable
                  rather than a small button floating at the right edge. */}
              <div className="mt-3 [&>div]:items-stretch [&_button]:h-11 [&_button]:w-full [&_button]:text-[13px]">
                <PortalButton />
              </div>
            </div>
          </Section>
        )}
      </AppBody>
    </>
  );
}
