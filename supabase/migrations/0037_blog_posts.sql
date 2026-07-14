-- ============================================================================
-- 0037 — Admin-authored blog posts.
--
-- The public blog has always been file-based (content/blog/<slug>.md), which
-- is perfect for committed, SEO-canonical content but useless for authoring at
-- runtime: Vercel's filesystem is read-only in production, so the admin panel
-- can't write markdown files. This table is the home for posts created from
-- /admin/blog. lib/blog.ts merges these published rows with the file posts
-- into one namespace (DB wins on slug collision), rendering both through the
-- same markdown -> semantic-HTML pipeline.
--
-- House-style notes: text+check status (never pg enums, like cohorts /
-- challenges), public.is_admin(auth.uid()) RLS, the shared
-- public.touch_updated_at() trigger, and `notify pgrst, 'reload schema'` at
-- the end. The public marketing surface reads via the service-role client
-- (RLS-bypass), so a public read policy isn't strictly required — but we add a
-- published-only anon read policy as defense-in-depth.
--
-- Run in the Supabase SQL Editor. Idempotent / safe to re-run.
-- ============================================================================

create table if not exists public.blog_posts (
  id uuid primary key default gen_random_uuid(),
  -- URL slug — the filename-equivalent. Unique across DB posts; a collision
  -- with a file post is resolved in app code (DB wins).
  slug text not null unique,
  title text not null,
  -- Meta description / SEO summary. Required in the form.
  description text not null default '',
  -- Optional list-page teaser; falls back to description when blank.
  excerpt text not null default '',
  -- Markdown source. Rendered to HTML on the fly by the shared pipeline.
  body text not null default '',
  category text not null default 'Playbook'
    check (category in ('Validate', 'Build', 'Market', 'Pitch', 'Founders', 'Playbook')),
  author_key text not null default 'team'
    check (author_key in ('rishabh', 'taran', 'team')),
  tags text[] not null default '{}',
  featured boolean not null default false,
  status text not null default 'draft'
    check (status in ('draft', 'published')),
  -- datePublished (drives ordering + JSON-LD). A plain date so backdating is
  -- trivial and display never shifts across timezones.
  published_on date not null default current_date,
  -- dateModified; falls back to published_on in app code when null.
  updated_on date,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists blog_posts_slug_idx on public.blog_posts(slug);
create index if not exists blog_posts_status_idx on public.blog_posts(status);
create index if not exists blog_posts_published_idx
  on public.blog_posts(published_on desc)
  where status = 'published';

drop trigger if exists touch_blog_posts on public.blog_posts;
create trigger touch_blog_posts before update on public.blog_posts
  for each row execute procedure public.touch_updated_at();

-- ============================================================================
-- Row Level Security
-- ============================================================================
alter table public.blog_posts enable row level security;

-- Anyone (incl. anon) may read PUBLISHED posts. The marketing surface reads via
-- the service-role client anyway (RLS-bypass); this policy is belt-and-braces
-- so a published post is never gated by accident, while drafts stay private.
drop policy if exists "blog_posts public read" on public.blog_posts;
create policy "blog_posts public read" on public.blog_posts
  for select using (status = 'published' or public.is_admin(auth.uid()));

-- Admins do everything (all writes go through the service-role admin client in
-- server actions, but this keeps the table correct under the authed client too).
drop policy if exists "blog_posts admin write" on public.blog_posts;
create policy "blog_posts admin write" on public.blog_posts
  for all using (public.is_admin(auth.uid()))
  with check (public.is_admin(auth.uid()));

notify pgrst, 'reload schema';
