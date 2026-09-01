-- ============================================================================
-- 0047 — challenge-uploads storage bucket
--
-- Backs the "Video (link or upload)" field type on the weekly-challenge apply
-- form. Applicants who don't want to paste a link can upload an .mp4 instead;
-- the file goes here and the submission answer stores `upload:<path>`.
--
-- Private bucket, mirroring course-videos (0001_init.sql): applicants write via
-- a one-shot signed upload URL minted server-side (see getChallengeUploadToken),
-- and admins read via short-lived signed URLs generated with the service role
-- on the submission review page. Neither path needs a broad RLS policy — the
-- admin-only ALL policy below is belt-and-suspenders for any direct access.
--
-- Idempotent — safe to re-run.
-- ============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'challenge-uploads',
  'challenge-uploads',
  false,
  209715200,            -- 200 MB, matches the client-side cap
  array['video/mp4']
)
on conflict (id) do nothing;

-- Only admins can touch objects directly. Applicant uploads are authorized by
-- the signed upload URL (not RLS); admin reads use the service role.
drop policy if exists "challenge-uploads admin all" on storage.objects;
create policy "challenge-uploads admin all" on storage.objects
  for all to authenticated
  using (bucket_id = 'challenge-uploads' and public.is_admin(auth.uid()))
  with check (bucket_id = 'challenge-uploads' and public.is_admin(auth.uid()));
