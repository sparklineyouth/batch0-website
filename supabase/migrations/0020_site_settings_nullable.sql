-- Allow site_settings.value to be SQL NULL.
--
-- The admin settings form upserts every key on every save, including
-- keys whose value is "unset" (e.g. active_cohort_id when no cohort is
-- pinned). PostgREST converts JS `null` to SQL NULL, which collided
-- with `value jsonb not null` and made the whole save fail — visible
-- to the admin as "the referrals toggle won't save."
--
-- Reads already tolerate NULL: every consumer in lib/site-config.ts
-- and app/admin/settings/page.tsx uses a `typeof` check that falls
-- back to a default when the value isn't the expected primitive type.
alter table public.site_settings
  alter column value drop not null;
