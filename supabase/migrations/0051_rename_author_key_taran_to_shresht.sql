-- Rename the blog author key `taran` -> `shresht`.
--
-- The display name moved in lib/blog-shared.ts (AUTHORS map), which is what
-- every byline, the admin list, the editor dropdown and the JSON-LD author
-- node read from. This migration moves the *key* underneath it so the two
-- don't disagree: `author_key` is a free-text column fenced by a check
-- constraint declared inline in 0037_blog_posts.sql, which Postgres named
-- `blog_posts_author_key_check`.
--
-- Order is load-bearing. The constraint has to come off BEFORE the update,
-- or the rows being written violate the very constraint we're replacing.

-- 1. Drop the old fence. `if exists` so a database that somehow never got the
--    inline constraint (or had it renamed by hand) doesn't fail the whole
--    migration.
alter table public.blog_posts
  drop constraint if exists blog_posts_author_key_check;

-- 2. Move the existing rows. Only DB-authored posts live here; the 41
--    committed markdown files carry their own `author:` frontmatter and are
--    updated in the same commit.
update public.blog_posts
  set author_key = 'shresht'
  where author_key = 'taran';

-- Safety net for step 3. The old constraint only ever permitted
-- ('rishabh','taran','team'), so after the remap above every row is already
-- inside the new roster and this touches nothing. It exists for the database
-- where that constraint was dropped by hand or never applied: without it, one
-- stray author_key makes `add constraint` fail and takes the whole deploy's
-- migration step down. Falling back to the house byline is recoverable; a
-- failed migration mid-deploy is not.
update public.blog_posts
  set author_key = 'team'
  where author_key not in ('rishabh', 'shresht', 'team');

-- 3. Re-fence with the new roster. Kept in lockstep with the AuthorKey union
--    and the AUTHORS map in lib/blog-shared.ts — if you add an author there,
--    add them here too or inserts will fail at write time.
alter table public.blog_posts
  add constraint blog_posts_author_key_check
  check (author_key in ('rishabh', 'shresht', 'team'));
