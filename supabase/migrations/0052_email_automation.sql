-- ============================================================================
-- 0052 — Admin-editable email: templates, automations, and a send queue.
--
-- Before this, every email the app sends was a TypeScript function in
-- lib/email/templates.ts — changing a single sentence meant a deploy. This
-- moves the copy into the database so an admin with `email.templates` can
-- rewrite any of it, and adds the two things that turn one-off sends into a
-- system: automations (an event or a schedule fires a sequence of templates)
-- and an outbox (the queue those sends land in, drained by cron).
--
-- The code templates stay as the fallback. `sendTemplated()` prefers the DB
-- row and falls back to the compiled function when the row is missing or
-- disabled, so this migration is safe to run late and safe to roll back: an
-- environment that hasn't run it keeps sending exactly what it sent before.
--
-- Run in Supabase SQL Editor (or `supabase db push`). Idempotent.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Templates
-- ---------------------------------------------------------------------------

create table if not exists public.email_templates (
  id uuid primary key default gen_random_uuid(),
  -- Stable identifier the code looks up by ("application.accepted"). System
  -- templates own their key permanently — renaming one would silently
  -- disconnect it from the call site that sends it, so the UI locks the field
  -- and a trigger below enforces it.
  key text not null unique,
  name text not null,
  description text,
  -- Grouping for the admin list only. Free text so new categories don't need
  -- a migration; the UI offers the known ones.
  category text not null default 'custom',
  subject text not null,
  preheader text,
  -- Sanitized HTML fragment — the *inner* body, not a whole document. The
  -- renderer wraps it in the branded layout at send time so a template edited
  -- a year ago still picks up the current header and footer.
  body_html text not null default '',
  cta_label text,
  cta_url text,
  -- Per-template sender overrides. Null means "use the configured default",
  -- which is the normal case; these exist for the occasional template that
  -- should come from a different address (e.g. billing@).
  from_name text,
  from_email text,
  reply_to text,
  -- Declared merge tags: [{ key, label, example, required }]. Drives the
  -- editor's insert menu and the preview's sample data. Purely advisory at
  -- send time — an undeclared tag still interpolates if the caller passes it.
  variables jsonb not null default '[]'::jsonb,
  -- True for the templates seeded to match a compiled fallback. These can be
  -- edited and disabled but not deleted or re-keyed, because a call site names
  -- them directly.
  is_system boolean not null default false,
  enabled boolean not null default true,
  version integer not null default 1,
  created_by uuid references public.profiles(id) on delete set null,
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists email_templates_category_idx
  on public.email_templates (category, name);
create index if not exists email_templates_enabled_idx
  on public.email_templates (enabled) where enabled;

-- Version history. Every save snapshots the *previous* content, so "I broke
-- the acceptance email at 2am" is one click to undo rather than a git
-- archaeology exercise. Email copy is the kind of thing people edit live and
-- under pressure; an undo is not a luxury here.
create table if not exists public.email_template_versions (
  id uuid primary key default gen_random_uuid(),
  template_id uuid not null references public.email_templates(id) on delete cascade,
  version integer not null,
  subject text not null,
  preheader text,
  body_html text not null,
  cta_label text,
  cta_url text,
  variables jsonb not null default '[]'::jsonb,
  edited_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (template_id, version)
);

create index if not exists email_template_versions_template_idx
  on public.email_template_versions (template_id, version desc);

-- A system template's key is load-bearing (a call site passes that literal),
-- so guard it in the database rather than trusting every future write path.
create or replace function public.email_template_guard()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'UPDATE' then
    if old.is_system and new.key is distinct from old.key then
      raise exception 'Cannot change the key of a system email template (%)', old.key;
    end if;
    -- is_system is set by the seed, never by the UI.
    new.is_system := old.is_system;
    new.updated_at := now();
  elsif tg_op = 'DELETE' then
    if old.is_system then
      raise exception 'Cannot delete the system email template % — disable it instead', old.key;
    end if;
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists email_template_guard_trg on public.email_templates;
create trigger email_template_guard_trg
  before update or delete on public.email_templates
  for each row execute function public.email_template_guard();

-- ---------------------------------------------------------------------------
-- Automations
-- ---------------------------------------------------------------------------

create table if not exists public.email_automations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  -- 'event'    — an app event fires it (application accepted, payment taken…)
  -- 'schedule' — a cron expression fires it against an audience
  -- 'manual'   — an admin fires it from the UI; useful for a saved broadcast
  trigger_type text not null default 'event'
    check (trigger_type in ('event', 'schedule', 'manual')),
  -- For trigger_type='event': the key from lib/email/catalog.ts.
  event_key text,
  -- For trigger_type='schedule': a 5-field cron expression, evaluated in UTC
  -- by the queue drainer. Not a pg_cron job — one Vercel cron drains
  -- everything, so adding an automation never needs an infra change.
  schedule_cron text,
  -- Audience selector for schedule/manual runs: { segment, cohortId, roles }.
  -- Event automations ignore it — the event carries its own recipient.
  audience jsonb not null default '{}'::jsonb,
  enabled boolean not null default true,
  -- Belt and braces against a mis-typed cron: an automation can't send the
  -- same person the same step twice inside this window.
  dedupe_window_hours integer not null default 24
    check (dedupe_window_hours >= 0),
  last_run_at timestamptz,
  last_error text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- An event automation needs an event; a scheduled one needs a schedule.
  -- Cheap to enforce here, and a broken row is otherwise invisible until the
  -- email that should have gone out didn't.
  constraint email_automations_trigger_shape check (
    (trigger_type = 'event' and event_key is not null)
    or (trigger_type = 'schedule' and schedule_cron is not null)
    or trigger_type = 'manual'
  )
);

create index if not exists email_automations_event_idx
  on public.email_automations (event_key) where enabled;
create index if not exists email_automations_schedule_idx
  on public.email_automations (trigger_type) where enabled;

-- The steps of a drip. One step is the common case (a plain transactional
-- send); several with delays is a sequence ("day 0 welcome, day 3 nudge,
-- day 7 last call").
create table if not exists public.email_automation_steps (
  id uuid primary key default gen_random_uuid(),
  automation_id uuid not null
    references public.email_automations(id) on delete cascade,
  step_index integer not null,
  template_id uuid not null references public.email_templates(id) on delete restrict,
  -- Minutes after the trigger (not after the previous step) — absolute
  -- offsets, so reordering or editing one step can't shift the ones after it.
  delay_minutes integer not null default 0 check (delay_minutes >= 0),
  -- Optional gate evaluated at send time, e.g. {"skipIf":{"appStatus":"paid"}}.
  -- A day-3 payment nudge must not go to someone who paid on day 1, and the
  -- decision has to be made when the mail leaves, not when it was queued.
  condition jsonb not null default '{}'::jsonb,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  unique (automation_id, step_index)
);

create index if not exists email_automation_steps_automation_idx
  on public.email_automation_steps (automation_id, step_index);

-- ---------------------------------------------------------------------------
-- Outbox
-- ---------------------------------------------------------------------------

create table if not exists public.email_outbox (
  id uuid primary key default gen_random_uuid(),
  -- Nullable: a one-off admin send has no automation behind it.
  automation_id uuid references public.email_automations(id) on delete set null,
  step_id uuid references public.email_automation_steps(id) on delete set null,
  template_id uuid references public.email_templates(id) on delete set null,
  to_email text not null,
  to_name text,
  -- The profile behind to_email when there is one. Lets the drainer evaluate
  -- step conditions and lets the admin outbox link a row to a person.
  user_id uuid references public.profiles(id) on delete set null,
  -- Merge-tag values captured at enqueue time.
  variables jsonb not null default '{}'::jsonb,
  -- Rendered copy for a one-off send with no template behind it. When
  -- template_id is set these stay null and the body is rendered at send time,
  -- so an edit to the template still lands on mail that hasn't gone out yet.
  subject_override text,
  html_override text,
  send_after timestamptz not null default now(),
  status text not null default 'pending'
    check (status in ('pending', 'sending', 'sent', 'failed', 'canceled', 'skipped')),
  attempts integer not null default 0,
  last_error text,
  provider_id text,
  -- Idempotency key. Unique where present, so a retried cron, a double-clicked
  -- button, and a webhook redelivery all collapse into one email.
  dedupe_key text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists email_outbox_dedupe_key_idx
  on public.email_outbox (dedupe_key) where dedupe_key is not null;
-- The drainer's hot path: "what is due?"
create index if not exists email_outbox_due_idx
  on public.email_outbox (send_after) where status = 'pending';
create index if not exists email_outbox_status_idx
  on public.email_outbox (status, created_at desc);
create index if not exists email_outbox_recipient_idx
  on public.email_outbox (to_email, created_at desc);

-- ---------------------------------------------------------------------------
-- Settings (singleton)
-- ---------------------------------------------------------------------------

create table if not exists public.email_settings (
  -- Enforced single row: the whole table is one config object, and a second
  -- row would mean two answers to "are sends paused?".
  id boolean primary key default true check (id),
  -- 'resend' (default) or 'smtp' (Gmail app password, or any SMTP relay).
  transport text not null default 'resend'
    check (transport in ('resend', 'smtp')),
  from_name text not null default 'batch0',
  from_email text not null default 'hello@batch0.org',
  reply_to text,
  smtp_host text,
  smtp_port integer,
  smtp_secure boolean not null default true,
  smtp_user text,
  -- AES-256-GCM ciphertext (see lib/email/secret.ts), never the raw password.
  -- The table is service-role-only, but a leaked backup shouldn't hand over a
  -- live Gmail account, and app passwords are bearer credentials with no
  -- scope limits.
  smtp_password_encrypted text,
  -- Global kill switch. Flip it and every automated send parks in the outbox
  -- instead of going out — the recovery move when a template goes wrong at
  -- 3am and there's no time to work out which automation did it.
  automations_paused boolean not null default false,
  -- Ceiling per queue drain, so a runaway automation is throttled rather than
  -- unlimited.
  max_sends_per_run integer not null default 200
    check (max_sends_per_run between 1 and 2000),
  updated_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now()
);

insert into public.email_settings (id) values (true)
  on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- RLS — admin reads, service-role writes
--
-- Every write path here runs through a server action or a cron route that has
-- already checked a permission and uses the service-role client. Granting the
-- browser session write access as well would just be a second, weaker door
-- onto the same tables.
-- ---------------------------------------------------------------------------

alter table public.email_templates enable row level security;
alter table public.email_template_versions enable row level security;
alter table public.email_automations enable row level security;
alter table public.email_automation_steps enable row level security;
alter table public.email_outbox enable row level security;
alter table public.email_settings enable row level security;

drop policy if exists "email_templates admin read" on public.email_templates;
create policy "email_templates admin read" on public.email_templates
  for select using (public.is_admin(auth.uid()));

drop policy if exists "email_template_versions admin read" on public.email_template_versions;
create policy "email_template_versions admin read" on public.email_template_versions
  for select using (public.is_admin(auth.uid()));

drop policy if exists "email_automations admin read" on public.email_automations;
create policy "email_automations admin read" on public.email_automations
  for select using (public.is_admin(auth.uid()));

drop policy if exists "email_automation_steps admin read" on public.email_automation_steps;
create policy "email_automation_steps admin read" on public.email_automation_steps
  for select using (public.is_admin(auth.uid()));

drop policy if exists "email_outbox admin read" on public.email_outbox;
create policy "email_outbox admin read" on public.email_outbox
  for select using (public.is_admin(auth.uid()));

-- Deliberately no read policy on email_settings: it holds the encrypted SMTP
-- credential, and the admin UI reads it through the service-role client with
-- the secret stripped before it reaches the client bundle.

notify pgrst, 'reload schema';
