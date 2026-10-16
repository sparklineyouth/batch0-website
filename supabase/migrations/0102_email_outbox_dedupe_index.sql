-- ============================================================================
-- 0102 — email_outbox: a dedupe index that ON CONFLICT can use.
--
-- 0052 made the dedupe_key unique index PARTIAL — `where dedupe_key is not
-- null`. The scheduled-automation fan-out (fanOutScheduled in
-- lib/email/queue.ts) upserts with `onConflict: "dedupe_key"`, which PostgREST
-- sends as a bare `on conflict (dedupe_key)`, and Postgres cannot infer a
-- partial index from a bare column list: every scheduled fan-out failed with
-- 42P10 ("there is no unique or exclusion constraint matching the ON CONFLICT
-- specification") and queued nothing. The drain logged it and stamped the run
-- as done with no error, so a scheduled automation looked healthy while
-- sending no mail. 0090 §9 fixed the same mistake on notifications; this is
-- that fix for the outbox.
--
-- A plain unique index has the same meaning, because NULLs are distinct in a
-- unique index: rows without a dedupe key (one-off sends) still never
-- collide, and the partial index already keeps the non-null keys unique, so
-- building it cannot fail on existing data. Built first, then the partial one
-- is dropped, so there is no moment without the guarantee.
--
-- Sends nothing by itself. An occurrence that failed was stamped as run and is
-- not retried; scheduled automations start queueing at their next occurrence.
--
-- Idempotent / safe to re-run. Assumes 0052. Guarded like 0090 §9.
-- ============================================================================

do $$
begin
  if to_regclass('public.email_outbox') is not null then
    execute 'create unique index if not exists email_outbox_dedupe_key_uniq on public.email_outbox (dedupe_key)';
    execute 'drop index if exists public.email_outbox_dedupe_key_idx';
  end if;
end $$;
