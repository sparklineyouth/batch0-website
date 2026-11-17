-- ---------------------------------------------------------------------------
-- 0112 — Attachments on outbound email
--
-- Two things: a private bucket to stage files in, and somewhere for a
-- SCHEDULED email to remember which files it is supposed to carry.
--
-- Why a bucket at all, when the file ends up inside the message anyway
-- --------------------------------------------------------------------
-- A Next.js server action body caps at 1 MB. A 10 MB PDF cannot travel
-- through one, so the browser uploads straight into storage against a
-- one-shot signed URL the server mints, and the draft carries only the path.
-- That is the same flow support attachments (0090), chat files (0101) and
-- challenge uploads already use; lib/email-attachment-rules.ts documents it
-- end to end.
--
-- The bucket is also the only place a size limit can actually be ENFORCED. A
-- signed upload URL carries no size or type constraint of its own, so every
-- check before the upload is advisory — it buys an honest person an instant,
-- specific error. file_size_limit below is the hard stop, and it is why the
-- number here and EMAIL_ATTACHMENT_MAX_BYTES must agree
-- (lib/email-attachment-rules.test.ts fails if they drift).
--
-- No RLS policies on storage.objects, deliberately, and for the same reason
-- 0090 wrote none for support-attachments: nothing reaches this bucket with a
-- user's own credentials. Uploads go through a signed URL the server minted
-- after checking email.send; reads happen server-side through the service
-- role while a message is being built. With the bucket private and no policy,
-- an authenticated browser client sees zero objects, which is correct.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. The bucket
-- ---------------------------------------------------------------------------

-- 10485760 = 10 MB = EMAIL_ATTACHMENT_MAX_BYTES. `allowed_mime_types` stays
-- null on purpose: browsers disagree about what a .csv or a .docx is (a .csv
-- arrives as text/csv on one machine and application/vnd.ms-excel on
-- another), and a bucket that refuses on MIME surfaces as an opaque 400 with
-- nothing an admin can act on. The allow-list is by extension, in the rules
-- module, and the type that storage records is checked when the file is read
-- back out — it just isn't the gate.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('email-attachments', 'email-attachments', false, 10485760, null)
on conflict (id) do update
  set public = false,
      allowed_mime_types = null,
      file_size_limit = greatest(
        coalesce(storage.buckets.file_size_limit, 0),
        10485760
      );

-- ---------------------------------------------------------------------------
-- 2. Attachments on a queued email
--
-- An immediate send never touches this column: it resolves its files and
-- hands them to the transport inside one request. A SCHEDULED send is the
-- case that needs it — the row sits in email_outbox until its send_after, and
-- the drainer (sendQueuedRow, lib/email/dispatch.ts) has to know what to
-- attach when it finally runs.
--
-- Paths, not bytes. Three reasons:
--   * a jsonb column is a poor place for 10 MB of base64, and every query
--     that selects the row would drag it along;
--   * the file may legitimately be replaced in storage before the send time,
--     and the send should carry what is there then;
--   * it keeps one copy of the file, which is what the orphan sweeper counts
--     on — it skips any object still referenced by an unsent row here.
--
-- Shape: [{"path": "...", "name": "...", "size": 123, "type": "..."}]
-- parseStagedEmailAttachments re-validates it on the way out, because this
-- column outlives the code that wrote it.
-- ---------------------------------------------------------------------------

alter table public.email_outbox
  add column if not exists attachments jsonb not null default '[]'::jsonb;

-- An array, and a small one. The rules module caps it at 5 entries; this
-- check is the backstop for anything that writes the column without going
-- through enqueueEmail. Deliberately loose about the entries themselves —
-- validating object shape in a CHECK constraint ages badly, and the reader
-- re-validates anyway.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'email_outbox_attachments_is_small_array'
  ) then
    alter table public.email_outbox
      add constraint email_outbox_attachments_is_small_array
      check (
        jsonb_typeof(attachments) = 'array'
        and jsonb_array_length(attachments) <= 5
      );
  end if;
end $$;

-- The sweeper asks "is any unsent row still pointing at this object?" once
-- per run, over a table that is mostly sent rows. Without an index that is a
-- sequential scan of the whole outbox every five minutes.
--
-- Partial, on pending rows with something attached — which is a handful of
-- rows at any time, so the index stays tiny.
create index if not exists email_outbox_pending_attachments_idx
  on public.email_outbox using gin (attachments)
  where status = 'pending' and attachments <> '[]'::jsonb;

comment on column public.email_outbox.attachments is
  'Staged email-attachments bucket paths for a scheduled send: [{path,name,size,type}]. Resolved to bytes at send time by lib/email/attachments.ts. Empty for immediate sends.';
