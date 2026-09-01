-- ============================================================================
-- 0057 — Promote the useful parts of a Resend webhook payload into columns.
--
-- 0024 stored the whole event in `payload` jsonb and pulled out four fields.
-- That was enough for "how many opened", but the payload has always carried the
-- answers to the questions people actually ask next, and none of them were
-- reachable without a full-table jsonb scan:
--
--   email.bounced   → bounce.type / subType / message
--                     ("permanent" is an address to purge; "transient" is a
--                      full mailbox that will clear on its own — averaging the
--                      two together hides the only one worth acting on)
--   email.clicked   → click.link, click.userAgent, click.ipAddress
--                     (which link, and from which mail client)
--   email.opened    → the user agent, which is how you tell a human open from
--                     Apple Mail Privacy Protection pre-fetching the pixel
--   email.failed    → failed.reason
--   any event       → tags, and with them the template that sent it — exact
--                     attribution instead of guessing from a subject prefix
--   any event       → broadcast_id, tying a send back to a Resend broadcast
--
-- Existing rows keep their payload, so the backfill at the bottom recovers all
-- of this retroactively; nothing is lost by having stored it late.
--
-- Run in Supabase SQL Editor. Idempotent / safe to re-run.
-- ============================================================================

alter table public.email_events
  add column if not exists broadcast_id text,
  add column if not exists template_key text,
  add column if not exists bounce_type text,
  add column if not exists bounce_subtype text,
  add column if not exists bounce_message text,
  add column if not exists click_link text,
  add column if not exists user_agent text,
  add column if not exists ip_address text,
  add column if not exists failure_reason text,
  add column if not exists tags jsonb;

-- Backfill from the payloads already on disk. `where ... is null` keeps a
-- re-run cheap and stops it from clobbering a value the ingest wrote directly.
update public.email_events
set
  broadcast_id   = coalesce(broadcast_id,   payload -> 'data' ->> 'broadcast_id'),
  bounce_type    = coalesce(bounce_type,    payload -> 'data' -> 'bounce' ->> 'type'),
  bounce_subtype = coalesce(bounce_subtype, payload -> 'data' -> 'bounce' ->> 'subType'),
  bounce_message = coalesce(bounce_message, payload -> 'data' -> 'bounce' ->> 'message'),
  click_link     = coalesce(click_link,     payload -> 'data' -> 'click' ->> 'link'),
  user_agent     = coalesce(user_agent,     payload -> 'data' -> 'click' ->> 'userAgent'),
  ip_address     = coalesce(ip_address,     payload -> 'data' -> 'click' ->> 'ipAddress'),
  failure_reason = coalesce(
                     failure_reason,
                     payload -> 'data' -> 'failed'     ->> 'reason',
                     payload -> 'data' -> 'suppressed' ->> 'message'
                   ),
  tags           = coalesce(tags,           payload -> 'data' -> 'tags'),
  template_key   = coalesce(
                     template_key,
                     payload -> 'data' -> 'tags' ->> 'template',
                     payload -> 'data' -> 'tags' ->> 'template_key'
                   )
where payload is not null
  and (
    broadcast_id is null or bounce_type is null or click_link is null
    or user_agent is null or failure_reason is null or tags is null
    or template_key is null
  );

-- "Which links get clicked" and "which template underperforms" are the two
-- grouped queries the metrics page runs; both are partial so the index only
-- covers the rows that can match.
create index if not exists email_events_click_link_idx
  on public.email_events (click_link) where click_link is not null;
create index if not exists email_events_template_key_idx
  on public.email_events (template_key) where template_key is not null;
create index if not exists email_events_broadcast_idx
  on public.email_events (broadcast_id) where broadcast_id is not null;
-- Powers the "problem addresses" list, which reads by recipient across the
-- bounce/complaint/failure event types.
create index if not exists email_events_recipient_idx
  on public.email_events (recipient, occurred_at desc);

notify pgrst, 'reload schema';
