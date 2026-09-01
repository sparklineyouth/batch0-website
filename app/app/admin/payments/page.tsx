import Link from "next/link";
import { requirePermission } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { StatusBadge } from "@/components/ui/card";
import { LocalTime } from "@/components/ui/local-time";
import { isoWeekStart, lastNWeeks } from "@/lib/week";
import {
  AppHeader,
  AppBody,
  Section,
  Stat,
  Row,
  Empty,
  Alert,
} from "@/components/app/frame";
import { Spark } from "@/components/app/viz";

export const metadata = { title: "Payments · Admin" };
export const dynamic = "force-dynamic";

/** Eight weeks: long enough for a cohort's payment wave to read as a wave,
 *  short enough that Spark's three axis ticks still describe the window. */
const WEEKS = 8;
const RECENT = 12;

function money(cents: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    // Whole dollars in a tile. The tile is a magnitude, and ".00" costs a font
    // step off Stat's clamp — the cents are on the transaction rows below,
    // where a partial refund is the thing you are actually reading.
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

function exactMoney(cents: number, currency = "usd") {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format(cents / 100);
}

/** PostgREST returns an embedded row as an object or a one-element array
 *  depending on the relationship it infers. Both shapes are the same fact. */
function embed<T>(value: unknown): T | null {
  if (!value) return null;
  return (Array.isArray(value) ? value[0] : value) as T;
}

/**
 * The money, without the ledger.
 *
 * The desktop ledger is a seven-column table inside `overflow-hidden`, and the
 * sixth column is a 27-character `pi_…` Stripe id in mono. That one cell pushes
 * the table's min-content width well past a phone, so the seventh column — the
 * Refund button — is clipped off the right edge with no scroll that reaches it.
 * A destructive money action, invisible and unreachable at 390px.
 *
 * This screen keeps what a phone can answer and drops what it can't. Two
 * numbers say where the program stands, a line says which way it is moving, and
 * the recent rows say whether the last charge landed. A per-payment screen owns
 * the Stripe id and the refund, because a refund needs a confirmation and the id
 * it is quoting — neither of which belongs in a list row you scroll past.
 *
 * Gated on `payments.view` and nothing weaker. ADMIN_ROUTE_PERMISSIONS in
 * lib/permissions.ts only covers /admin/*, so every route under /app/admin
 * states its own permission, exactly as the Review screen does.
 */
export default async function AdminAppPayments() {
  await requirePermission("payments.view");
  const admin = createAdminClient();
  const weeks = lastNWeeks(WEEKS);

  const [ledgerRes, seriesRes, recentRes] = await Promise.all([
    // The same row-by-row sum and the same explicit cap as the desktop ledger
    // and the admin home tile. Past ~10k payments all three need to become one
    // SQL aggregate, and they need to move together or they start disagreeing.
    admin.from("payments").select("amount_cents, status, user_id").limit(10000),
    // The trend is its own bounded query rather than a slice of the scan above:
    // eight weeks of succeeded rows can never be truncated by that 10k cap, so
    // the line stays correct even on the day the cap starts biting the total.
    admin
      .from("payments")
      .select("created_at")
      .eq("status", "succeeded")
      .gte("created_at", weeks[0].start.toISOString()),
    admin
      .from("payments")
      .select(
        "id, created_at, amount_cents, currency, status, profile:profiles(full_name, email)",
      )
      .order("created_at", { ascending: false })
      .limit(RECENT),
  ]);

  const ledger = (ledgerRes.data ?? []) as {
    amount_cents: number | null;
    status: string;
    user_id: string;
  }[];

  const succeeded = ledger.filter((p) => p.status === "succeeded");
  const grossCents = succeeded.reduce((s, p) => s + (p.amount_cents ?? 0), 0);
  const refundedCents = ledger
    .filter((p) => p.status === "refunded")
    .reduce((s, p) => s + (p.amount_cents ?? 0), 0);
  const netCents = grossCents - refundedCents;
  const payingStudents = new Set(succeeded.map((p) => p.user_id)).size;
  const pendingCount = ledger.filter((p) => p.status === "pending").length;
  const failedCount = ledger.filter((p) => p.status === "failed").length;

  // The axis comes from the calendar, not from the rows. A `.gte(created_at)`
  // query returns nothing at all for a week with no payments, so bucketing the
  // returned rows alone would draw a four-point line and call it eight weeks.
  const perWeek = new Map<string, number>();
  for (const p of (seriesRes.data ?? []) as { created_at: string }[]) {
    const key = isoWeekStart(new Date(p.created_at));
    perWeek.set(key, (perWeek.get(key) ?? 0) + 1);
  }
  const points = weeks.map((w) => ({
    key: w.key,
    label: w.label,
    value: perWeek.get(w.key) ?? 0,
  }));
  const windowTotal = points.reduce((s, p) => s + p.value, 0);

  const recent = (recentRes.data ?? []) as {
    id: string;
    created_at: string;
    amount_cents: number | null;
    currency: string | null;
    status: string;
    profile: unknown;
  }[];

  return (
    <>
      <AppHeader
        title="Payments"
        eyebrow={
          // An error is not a settled ledger. "$0 net" on a failed query tells
          // an admin the program has taken no money, which is the one wrong
          // answer this screen can give.
          ledgerRes.error
            ? "Couldn't load the ledger"
            : pendingCount + failedCount > 0
              ? `${pendingCount} pending · ${failedCount} failed`
              : "All settled"
        }
      />
      <AppBody>
        {ledgerRes.error ? (
          <Alert tone="warn" title="The payments query failed.">
            Nothing was read, so nothing below is a real number. Reload, and if
            it keeps failing the full ledger at /admin/payments has the same
            data.
          </Alert>
        ) : (
          <>
            <Section title="The ledger">
              <div className="grid grid-cols-2 gap-2.5">
                <Stat
                  // "Net payments", not "Net revenue". The tile that links here
                  // is the start screen's "Revenue", and that one sums
                  // `payments` AND `user_charges` (fees and fines) while this
                  // scan — like the desktop ledger it mirrors — reads `payments`
                  // alone. Two tiles one tap apart, both called revenue, showing
                  // different totals is the one thing a money screen must not
                  // do; naming this one after what it actually counts costs a
                  // word and removes the contradiction.
                  label="Net payments"
                  value={money(netCents)}
                  tone="accent"
                  // Full width, for the same reason the start screen's Revenue
                  // tile spans: this is a lifetime total, and Stat's own note
                  // records that a lifetime currency string is the one value
                  // long enough to overflow a half-grid tile even at the
                  // clamped size. At 320px a half tile has ~101px of content
                  // box and 24px type, so "$123,456" needs ~115px — and
                  // `body { overflow-x: clip }` turns that into a collision
                  // with the tile beside it rather than a scroll.
                  span
                  hint={
                    refundedCents > 0
                      ? `${money(grossCents)} gross · ${money(refundedCents)} refunded`
                      : "Nothing refunded"
                  }
                />
                <Stat
                  label="Paying students"
                  value={payingStudents}
                  hint={`${succeeded.length} successful charge${
                    succeeded.length === 1 ? "" : "s"
                  }`}
                />
              </div>
              <p className="mt-3 text-[11.5px] leading-relaxed text-ink-faint">
                Tuition payments only. Fees and fines are billed separately and
                are counted in the Revenue total on the start screen, not here.
              </p>
            </Section>

            <Section
              title="Succeeded payments"
              action={
                <span className="font-mono text-[11px] tabular-nums text-ink-faint">
                  {windowTotal} in {WEEKS} weeks
                </span>
              }
            >
              {/* Count, not dollars: the tiles above already carry the money,
                  and what this line adds is whether people are still buying —
                  which one large charge would otherwise disguise. */}
              <Spark
                label="Succeeded payments per week"
                points={points}
                format={(n) => String(n)}
              />
            </Section>
          </>
        )}

        <Section title="Recent transactions">
          {recentRes.error ? (
            // Same rule as the tiles above: an empty result set and a failed
            // read are not the same fact, and "No payments yet" is the wrong
            // one to guess. This query is separate from the ledger scan, so it
            // can fail on its own while the tiles render fine.
            <Alert tone="warn" title="Couldn't load recent transactions.">
              The read failed, so this list is empty for the wrong reason.
            </Alert>
          ) : recent.length === 0 ? (
            <Empty>No payments yet.</Empty>
          ) : (
            <div className="rounded-2xl border border-line px-4 sm:px-5">
              {recent.map((p) => {
                const profile = embed<{
                  full_name: string | null;
                  email: string | null;
                }>(p.profile);
                return (
                  // Deliberately not a link. The destination for a transaction
                  // is a per-payment screen carrying the Stripe id and the
                  // refund, and that screen does not exist yet — a row that
                  // navigates to a 404 is worse on a touch screen than a row
                  // that plainly does nothing.
                  <Row
                    key={p.id}
                    label={profile?.full_name || profile?.email || "Unknown payer"}
                    meta={<LocalTime value={p.created_at} mode="date" />}
                    right={
                      <div className="flex shrink-0 items-center gap-2">
                        <span className="font-mono text-[12.5px] tabular-nums text-ink-soft">
                          {exactMoney(p.amount_cents ?? 0, p.currency ?? "usd")}
                        </span>
                        <StatusBadge status={p.status} />
                      </div>
                    }
                  />
                );
              })}
            </div>
          )}
        </Section>

        <p className="mt-5 text-center text-[12px] leading-relaxed text-ink-faint">
          Refunding a payment needs the Stripe id and a confirmation you can read
          — that is a laptop job, and{" "}
          <Link
            href="/admin/payments"
            prefetch={false}
            className="text-phosphor-ink underline"
          >
            the full ledger
          </Link>{" "}
          has both.
        </p>
      </AppBody>
    </>
  );
}
