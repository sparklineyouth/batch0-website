-- ============================================================================
-- 0100 — Admin cleanup: retired pages leave no data behind.
--
-- The AI usage page (/admin/ai-usage) is gone, and with it the permission key
-- that opened it. A role still holding 'ai_usage.view' would be harmless to
-- can(), but missingPermissions() treats every stored string as something the
-- editor must hold too — so a stale key blocks non-superadmins from editing
-- or assigning that role. Strip it. The ai_usage table stays: the monthly
-- spend cap and overage billing (lib/ai/usage.ts) still read it.
--
-- The founder-pass self-check is gone too. Its probe rows (batch 'selftest',
-- negative serials) were never passes, and it deleted them itself; one only
-- survives a run that crashed mid-way, possibly still bound to the admin who
-- ran it. Nothing clears them any more, so do it here. Real passes are always
-- positive serials and are only ever revoked, never deleted.
--
-- No schema change; the app does not depend on this having run.
--
-- Run in Supabase SQL Editor. Idempotent / safe to re-run.
-- Assumes 0039 (founder_passes) and 0048 (app_roles) are applied.
-- ============================================================================

update public.app_roles
set permissions = array_remove(permissions, 'ai_usage.view')
where permissions @> array['ai_usage.view']::text[];

delete from public.founder_passes
where batch = 'selftest'
  and serial < 0;

notify pgrst, 'reload schema';
