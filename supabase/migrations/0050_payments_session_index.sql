-- The Stripe webhook and checkout-return fulfillment path look payments up by
-- stripe_session_id; the table only had payments_user_id_idx, so every webhook
-- delivery and return-from-checkout render paid for a sequential scan that
-- grows with payment volume.
create index if not exists payments_stripe_session_id_idx
  on public.payments (stripe_session_id);
