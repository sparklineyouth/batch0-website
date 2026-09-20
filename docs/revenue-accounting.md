# Revenue and enrollment accounting

Deploy migrations `0080_revenue_ledger.sql` and `0081_parent_checkout.sql` before the matching application code. The second migration extends the settlement RPC with reservation rules. Both functions are callable only by `service_role`; never expose them through a public client. This changes accounting and enrollment state handling, not the published refund policy.

## Definitions

- **Captured tuition** is Stripe's actual captured amount, stored in `payments.amount_cents`. A pending row is only a quote; settlement replaces its amount and currency.
- **Refunded tuition** is cumulative `amount_refunded_cents`. Full refunds retain the original captured amount and mark the row `refunded`. Gross includes captured and subsequently refunded payments; retained money subtracts refunds exactly once.
- **Paying people** counts distinct users retaining positive USD tuition. A free, manually granted, or fully refunded enrollment is not a paying customer. Enrollment counts measure occupied places separately.
- **Overview money** includes retained USD tuition, fees and Demo Day tickets, before processing fees. Payment-page totals are tuition only. Non-USD transactions must be reported separately; currencies are never added together.
- **Payment date** comes from a Stripe success event. A successful automatically captured card Charge also supplies its payment timestamp for immediate Checkout returns. Delayed methods require their actual success event. Unknown historical dates stay unknown; checkout creation and reconciliation time are never substituted. Pulse charts show gross USD tuition by verified payment date, excluding unknown dates.
- **Pricing simulator** uses an assumed starting payer count and assumed elasticity. Historical customers bought at different prices; the chart is neither measured price sensitivity nor a recommended optimum.

## Payment/refund consistency

Settlement and refund cleanup lock cohort then application so they agree with seat reservation. Every settlement writes the authoritative captured amount, receipt, currency and verified payment date, including replays. Current Stripe refund state is inspected before access can be granted. A fully refunded Checkout never resurrects enrollment.

If a refund arrives before the pending record has its Stripe payment-intent ID, the handler finds the actual Checkout session and silently records its current state before cleanup. A concurrent completion using an older snapshot then observes the persisted refund and cannot restore access. Fees and tickets also inspect current captured/refunded state; a conditional status transition prevents duplicate completion announcements.

A full refund always runs access cleanup, even if an older admin action already marked its payment refunded. A retained replacement payment for the same student/cohort preserves access only when its application was fulfilled, including when the replacement belongs to another application. Money captured against a blocked or withdrawn application does not qualify as a replacement entitlement. Otherwise the refunded application becomes withdrawn and its enrollment is removed. This keeps former customers out of accepted-unpaid recovery lists. Partial refunds preserve access; older events cannot reduce the recorded cumulative refund.

Successful money that cannot safely grant enrollment stays in the ledger and creates a `payment.enrollment_blocked` audit record. Staff must resolve the underlying eligibility/capacity/refund issue. Do not silently treat it as a completed enrollment or automatically charge/refund again.

## Reconciliation and rollout

1. Back up the specific affected payment/application/enrollment rows privately, and compare Stripe payment intent + Checkout session identity, actual captured amount, currency and refund amount.
2. Apply the two migrations and deploy matching code. Reconciliation is a write operation: it can change application and enrollment state. Use `silent: true` to suppress receipt messages.
3. Reconcile sessions and current refunds. Recent `payment_intent.succeeded` events recover verified timestamps within Stripe's available event history; older missing dates remain explicitly unknown. Unlinked payments without Batch0 application/ticket/charge metadata need manual classification, not invented attribution.
4. Read back amounts, statuses, refund totals, access and queued recovery eligibility. Review blocked-payment audit entries. Neither historical failed session counts nor repeated payment-intent references are unique customers or unique card declines.
5. Reconcile any historical full refund that was pre-marked locally: repeated cleanup is safe. Do not delete old money rows to make reports agree.

Focused offline verification: `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test lib/revenue-ledger*.test.ts`. The PGlite tests execute the actual migration/RPCs with stale quoted prices, refunds, replacements, out-of-order events, closed applications, permissions and replay. The reservation test suite covers the 0081 replacement function and capacity behavior.

`lib/recovery-migration-db.test.ts` executes 0082 against synthetic records to verify private staff notes, protected pause state, and no email sends. `lib/schedule-migration-db.test.ts` executes 0083 against a fixture containing only public Fall event metadata; it checks all 18 event times, the daylight-saving transition, the approved intro time, repeatability, and rollback on unexpected dates. The fixture has no student data, email addresses, meeting URLs or payment records.
