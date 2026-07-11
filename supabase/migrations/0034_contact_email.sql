-- Update the public contact email to the sparklineyouth.org address.
--
-- `contact_email` is admin-controlled data in site_settings (seeded in
-- 0001_init.sql, editable at /admin/settings), so it overrides the code
-- fallback (lib/site-config.ts FALLBACK_SETTINGS). The footer, the "Who runs
-- this" founder block, and the sponsor contact mailto all read this value —
-- they kept showing the old Gmail until this row is updated. Unlike the
-- initial seed this OVERWRITES an existing row (on conflict do update).
insert into public.site_settings (key, value, updated_at)
values ('contact_email', '"hello@sparklineyouth.org"', now())
on conflict (key) do update
  set value = excluded.value,
      updated_at = now();
