/** Every migration, replayed onto an empty database the way Supabase applies
 * them; NEVER connects to linked Supabase.
 *
 * Run: npm run test:migrations-replay-db
 *
 * Why this exists: Supabase's GitHub integration runs the Supabase CLI's
 * migration code against production on every push to main (the "Supabase
 * Preview" check), and a preview branch's first build runs the same code
 * against an empty database. From 2026-09-20 that check failed on every
 * commit while CI stayed green: two files were both version 0071, the
 * history table's primary key is the version, and nothing in CI ran the files
 * the way the CLI does. This does:
 *
 *   - files in the CLI's order (directory order: by file name), split into
 *     statements by a port of the CLI's own splitter and run one statement at
 *     a time over the extended protocol, each file in one transaction, as the
 *     CLI's batch does;
 *   - each file recorded exactly as the CLI records it, an INSERT into
 *     supabase_migrations.schema_migrations(version, name, statements), so a
 *     second file with the same version fails here the way it fails there;
 *   - which files a database still needs decided the way the integration
 *     decides: the CLI's FindPendingMigrations, out-of-order files included
 *     (--include-all; the integration ran 0071_scholarships out of order,
 *     where a plain `supabase db push` would have refused).
 *
 * Ported from supabase/cli v2.98.2: pkg/parser/state.go + token.go (the
 * splitter), pkg/migration/{list,apply,file,history}.go and
 * internal/migration/up (ordering, pending, recording), and
 * internal/migration/repair (repair --status applied).
 *
 * The database starts the way a new Supabase project does: the API roles,
 * pgcrypto in `extensions`, auth, storage, realtime and an empty
 * supabase_realtime publication, with Supabase's names for everything these
 * files touch. What it can't show: PGlite runs as a superuser, so a statement
 * Supabase's non-superuser `postgres` may not run passes here; and auth,
 * storage and realtime are stand-ins, not Supabase's own schemas.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";

const DIR = new URL("../supabase/migrations/", import.meta.url);

/** The CLI's file pattern (pkg/migration/file.go): the version is every digit before the first underscore. */
const CLI_FILE = /^([0-9]+)_(.*)\.sql$/;

type CliFile = { file: string; version: string; name: string; statements: string[] };

// ---------------------------------------------------------------------------
// The CLI's statement splitter (pkg/parser), state for state. It is not
// Postgres's lexer: a backslash outside a string escapes the next character,
// parentheses and BEGIN ATOMIC … END hold semicolons, and a backslash-escaped
// quote inside E'…' is NOT understood (write '' instead).
// ---------------------------------------------------------------------------

type State =
  | { k: "ready" }
  | { k: "comment" }
  | { k: "block"; depth: number }
  | { k: "quote"; delimiter: string; escape: boolean }
  | { k: "dollar"; delimiter: string }
  | { k: "tag"; offset: number }
  | { k: "escape" }
  | { k: "atomic"; prev: State; delimiter: string };

const isIdentifier = (c: string | undefined) => !!c && /[\p{L}\p{N}_$]/u.test(c);

function isBeginAtomic(data: string): boolean {
  let offset = data.length - "ATOMIC".length;
  if (offset < 0 || data.slice(offset).toUpperCase() !== "ATOMIC") return false;
  if (offset > 0 && isIdentifier(data[offset - 1])) return false;
  const prefix = data.slice(0, offset).replace(/\s+$/u, "");
  offset = prefix.length - "BEGIN".length;
  if (offset < 0 || prefix.slice(offset).toUpperCase() !== "BEGIN") return false;
  return offset === 0 || !isIdentifier(prefix[offset - 1]);
}

/** One rune in; the next state, or null to end the statement here. `data` is the statement so far. */
function step(s: State, r: string, data: string): State | null {
  switch (s.k) {
    case "ready":
      switch (r) {
        case "$":
          return { k: "tag", offset: data.length - 1 };
        case "'":
        case '"':
          return { k: "quote", delimiter: r, escape: false };
        case "-":
          return { k: "comment" };
        case "/":
          return { k: "block", depth: 0 };
        case "\\":
          return { k: "escape" };
        case ";":
          return null;
        case "(":
          return { k: "atomic", prev: s, delimiter: ")" };
        case "c":
        case "C":
          if (isBeginAtomic(data)) return { k: "atomic", prev: s, delimiter: "END" };
      }
      return s;
    case "comment":
      // A line comment runs to the newline, like a dollar quote whose tag is "\n".
      return r === "-" ? { k: "dollar", delimiter: "\n" } : step({ k: "ready" }, r, data);
    case "block": {
      const window = data.slice(-2);
      if (window === "/*") {
        s.depth += 1;
        return s;
      }
      if (s.depth === 0) return step({ k: "ready" }, r, data);
      if (window === "*/") {
        s.depth -= 1;
        if (s.depth === 0) return { k: "ready" };
      }
      return s;
    }
    case "quote":
      if (s.escape) {
        if (r === s.delimiter) {
          s.escape = false;
          return s;
        }
        return step({ k: "ready" }, r, data);
      }
      if (r === s.delimiter) s.escape = true;
      return s;
    case "dollar":
      return data.endsWith(s.delimiter) ? { k: "ready" } : s;
    case "tag":
      if (r === "$") return { k: "dollar", delimiter: data.slice(s.offset) };
      if (/[\p{L}\p{N}_]/u.test(r)) return s;
      return step({ k: "ready" }, r, data);
    case "escape":
      return { k: "ready" };
    case "atomic": {
      const curr = step(s.prev, r, data);
      if (curr !== null) s.prev = curr;
      if (s.prev.k === "ready" && data.slice(-s.delimiter.length).toUpperCase() === s.delimiter.toUpperCase()) {
        return { k: "ready" };
      }
      return s;
    }
  }
}

/** parser.SplitAndTrim: statements as the CLI sends them, comments kept, the trailing ";" and whitespace trimmed. */
function cliSplit(sql: string): string[] {
  const out: string[] = [];
  let state: State = { k: "ready" };
  let data = "";
  for (const r of sql) {
    data += r;
    const next = step(state, r, data);
    if (next === null) {
      out.push(data);
      data = "";
      state = { k: "ready" };
    } else {
      state = next;
    }
  }
  if (data) out.push(data);
  return out.map((t) => t.replace(/;+$/, "").trim()).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Which files, in what order (pkg/migration/list.go, apply.go; internal/migration/up)
// ---------------------------------------------------------------------------

/**
 * The migrations directory as the CLI reads it, sorted by file name.
 * `rename` lays the files out under other names (the layout before a rename).
 */
function layout(rename: Record<string, string> = {}): CliFile[] {
  return readdirSync(DIR)
    .map((file) => ({ source: file, file: rename[file] ?? file }))
    .filter(({ file }) => CLI_FILE.test(file))
    .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
    .map(({ source, file }) => {
      const [, version, name] = CLI_FILE.exec(file)!;
      return { file, version, name, statements: cliSplit(readFileSync(new URL(source, DIR), "utf8")) };
    });
}

/**
 * FindPendingMigrations + GetPendingMigrations(includeAll): local files that
 * sort before the newest recorded version but aren't recorded themselves
 * ("out of order"), then everything newer than the history. Versions compare
 * as strings, file against history row, in step.
 */
function cliPending(local: readonly CliFile[], remote: readonly string[]): CliFile[] {
  const unapplied: CliFile[] = [];
  const missing: string[] = [];
  let i = 0;
  let j = 0;
  while (i < remote.length && j < local.length) {
    if (remote[i] === local[j].version) {
      i++;
      j++;
    } else if (remote[i] < local[j].version) {
      missing.push(remote[i++]);
    } else {
      unapplied.push(local[j++]);
    }
  }
  if (j === local.length) missing.push(...remote.slice(i));
  if (missing.length) throw new Error(`Remote migration versions not found in local migrations directory: ${missing.join(", ")}`);
  return [...unapplied, ...local.slice(remote.length + unapplied.length)];
}

class CliError extends Error {
  readonly file: string;
  /** The CLI's "At statement: N": how many statements succeeded first (N = the file's count means the history INSERT failed). */
  readonly statement: number;
  readonly code: string | undefined;
  constructor(file: string, statement: number, cause: { message?: string; code?: string }) {
    super(`${file}: ${cause.message} (SQLSTATE ${cause.code})\nAt statement: ${statement}`);
    this.file = file;
    this.statement = statement;
    this.code = cause.code;
  }
}

// ---------------------------------------------------------------------------
// The database
// ---------------------------------------------------------------------------

/** What a new Supabase project has before its first migration, as far as these files reach. */
const SUPABASE_PROJECT = String.raw`
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin noinherit bypassrls; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then create role authenticator login noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then create role supabase_auth_admin login noinherit createrole; end if;
  if not exists (select 1 from pg_roles where rolname = 'supabase_storage_admin') then create role supabase_storage_admin login noinherit createrole; end if;
end $$;
grant anon, authenticated, service_role to authenticator;

create schema extensions;
create extension pgcrypto with schema extensions;
grant usage on schema extensions to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;

create schema auth;
grant usage on schema auth to anon, authenticated, service_role;
create table auth.users (
  instance_id uuid, id uuid primary key, aud varchar(255), role varchar(255), email varchar(255),
  encrypted_password varchar(255), email_confirmed_at timestamptz, invited_at timestamptz,
  confirmation_token varchar(255), confirmation_sent_at timestamptz, recovery_token varchar(255),
  recovery_sent_at timestamptz, email_change varchar(255), last_sign_in_at timestamptz,
  raw_app_meta_data jsonb, raw_user_meta_data jsonb, is_super_admin boolean,
  created_at timestamptz, updated_at timestamptz, phone text unique, phone_confirmed_at timestamptz,
  banned_until timestamptz, deleted_at timestamptz,
  is_sso_user boolean not null default false, is_anonymous boolean not null default false
);
create function auth.uid() returns uuid language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
                  (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid $$;
create function auth.role() returns text language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''),
                  (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'))::text $$;
create function auth.email() returns text language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.email', true), ''),
                  (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email'))::text $$;
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim', true), ''),
                  nullif(current_setting('request.jwt.claims', true), ''))::jsonb $$;

create schema storage;
grant usage on schema storage to anon, authenticated, service_role;
create table storage.buckets (
  id text primary key, name text not null, owner uuid, owner_id text,
  created_at timestamptz default now(), updated_at timestamptz default now(),
  public boolean default false, avif_autodetection boolean default false,
  file_size_limit bigint, allowed_mime_types text[], type text not null default 'STANDARD'
);
create unique index bname on storage.buckets (name);
create table storage.objects (
  id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets (id),
  name text, owner uuid, owner_id text, created_at timestamptz default now(),
  updated_at timestamptz default now(), last_accessed_at timestamptz default now(), metadata jsonb,
  path_tokens text[] generated always as (string_to_array(name, '/')) stored,
  version text, user_metadata jsonb
);
create unique index bucketid_objname on storage.objects (bucket_id, name);
alter table storage.buckets enable row level security;
alter table storage.objects enable row level security;
grant all on storage.buckets, storage.objects to anon, authenticated, service_role;
create function storage.foldername(name text) returns text[] language plpgsql as $$
declare _parts text[];
begin
  select string_to_array(name, '/') into _parts;
  return _parts[1:array_length(_parts, 1) - 1];
end $$;
create function storage.filename(name text) returns text language plpgsql as $$
declare _parts text[];
begin
  select string_to_array(name, '/') into _parts;
  return _parts[array_length(_parts, 1)];
end $$;
create function storage.extension(name text) returns text language plpgsql as $$
declare _parts text[];
begin
  select string_to_array(name, '/') into _parts;
  return reverse(split_part(reverse(_parts[array_length(_parts, 1)]), '.', 1));
end $$;

create schema realtime;
grant usage on schema realtime to anon, authenticated, service_role;
create table realtime.messages (
  topic text not null, extension text not null, payload jsonb, event text, private boolean default false,
  updated_at timestamp not null default now(), inserted_at timestamp not null default now(),
  id uuid not null default gen_random_uuid(), primary key (id, inserted_at)
);
alter table realtime.messages enable row level security;
grant select, insert, update on realtime.messages to anon, authenticated, service_role;
create function realtime.topic() returns text language sql stable as $$
  select nullif(current_setting('realtime.topic', true), '')::text $$;

create publication supabase_realtime;
`;

async function supabaseProject(): Promise<PGlite> {
  const db = new PGlite({ extensions: { pgcrypto, pg_trgm } });
  await db.exec(SUPABASE_PROJECT);
  return db;
}

/** CreateMigrationTable, verbatim. */
async function createHistory(db: PGlite): Promise<void> {
  await db.exec(`
    create schema if not exists supabase_migrations;
    create table if not exists supabase_migrations.schema_migrations (version text not null primary key);
    alter table supabase_migrations.schema_migrations add column if not exists statements text[];
    alter table supabase_migrations.schema_migrations add column if not exists name text;
  `);
}

/** ListRemoteMigrations: the recorded versions, in order; none before the table exists. */
async function recorded(db: PGlite): Promise<string[]> {
  const exists = await db.query<{ ok: boolean }>(`select to_regclass('supabase_migrations.schema_migrations') is not null as ok`);
  if (!exists.rows[0].ok) return [];
  return (await db.query<{ version: string }>(`select version from supabase_migrations.schema_migrations order by version`)).rows.map((r) => r.version);
}

/** MigrationFile.ExecBatch: every statement, then the history INSERT, all or nothing. */
async function applyFile(db: PGlite, f: CliFile): Promise<void> {
  // ApplyMigrations runs RESET ALL before each file; Supabase's postgres role
  // then has `extensions` on its search_path.
  await db.exec(`reset all; set search_path to "$user", public, extensions;`);
  await db.exec("begin");
  let i = 0;
  try {
    for (; i < f.statements.length; i++) await db.query(f.statements[i]);
    await db.query(`insert into supabase_migrations.schema_migrations(version, name, statements) values ($1, $2, $3)`, [
      f.version,
      f.name,
      f.statements,
    ]);
    // A file with its own BEGIN … COMMIT (0067, 0082, 0083, 0085) has already
    // ended this transaction; COMMIT then only warns, as it would there.
    await db.exec("commit");
  } catch (err) {
    await db.exec("rollback").catch(() => undefined);
    throw new CliError(f.file, i, err as { message?: string; code?: string });
  }
}

/** What the integration does on a push to main: create the history table, then apply what's pending, in order, stopping at the first failure. */
async function push(db: PGlite, local: readonly CliFile[]): Promise<string[]> {
  const pending = cliPending(local, await recorded(db));
  if (pending.length) await createHistory(db);
  for (const f of pending) await applyFile(db, f);
  return pending.map((f) => f.file);
}

/** `supabase migration repair --status applied <version>`: upsert the row from the local file, run nothing. */
async function repairApplied(db: PGlite, local: readonly CliFile[], version: string): Promise<void> {
  // GetMigrationFile globs <version>_*.sql and takes the first match, by name.
  const f = local.find((m) => m.version === version);
  assert.ok(f, `no local file for ${version}`);
  await createHistory(db);
  await db.query(
    `insert into supabase_migrations.schema_migrations(version, name, statements) values ($1, $2, $3)
     on conflict (version) do update set name = excluded.name, statements = excluded.statements`,
    [f.version, f.name, f.statements],
  );
}

// ---------------------------------------------------------------------------
// The tests
// ---------------------------------------------------------------------------

/** How the files were laid out until October 2026: the viewer count shared 0071 with scholarships. */
const SHARED_0071 = { "0078_event_display_viewer_count.sql": "0071_event_display_viewer_count.sql" };

test("the CLI's statement splitter, ported: what splits and what doesn't", () => {
  assert.deepEqual(cliSplit("select 1;\nselect 2;"), ["select 1", "select 2"]);
  assert.deepEqual(cliSplit("do $$ begin perform 1; end $$; select ';' ;"), ["do $$ begin perform 1; end $$", "select ';'"]);
  assert.deepEqual(cliSplit("create function f() returns int language sql as $fn$ select 1; $fn$;\n-- a trailing; comment\n"), [
    "create function f() returns int language sql as $fn$ select 1; $fn$",
    "-- a trailing; comment",
  ]);
  assert.deepEqual(cliSplit("/* one; /* two; */ still; */ select 1; select 'it''s; fine', \"a;b\";"), [
    "/* one; /* two; */ still; */ select 1",
    "select 'it''s; fine', \"a;b\"",
  ]);
  assert.deepEqual(cliSplit("create function f() returns int language sql begin atomic select 1; select 2; end; select 3;"), [
    "create function f() returns int language sql begin atomic select 1; select 2; end",
    "select 3",
  ]);
  // The quirk to stay clear of: \' inside E'…' ends the string for the CLI,
  // so everything after it lands in one statement, which Postgres then
  // refuses (the replay below runs statements the same way, so it would fail).
  assert.deepEqual(cliSplit("select E'it\\'s'; select 2;"), ["select E'it\\'s'; select 2"]);
});

let fresh: PGlite;

test("a fresh database: every file applies, in the CLI's order, each under a version of its own", async () => {
  const files = layout();
  fresh = await supabaseProject();
  // One statement per query, as the CLI sends them: two glued together fail.
  await assert.rejects(fresh.query("select 1; select 2"), /multiple commands/);
  assert.deepEqual(await push(fresh, files), files.map((f) => f.file));
  assert.deepEqual(await recorded(fresh), files.map((f) => f.version));
  // A second push has nothing to do.
  assert.deepEqual(cliPending(files, await recorded(fresh)), []);

  // Both files that used to share 0071 ran, and 0072 ran after scholarships.
  const has = async (sql: string) => (await fresh.query<{ ok: boolean }>(sql)).rows[0].ok;
  assert.equal(await has(`select to_regclass('public.scholarships') is not null as ok`), true);
  assert.equal(
    await has(`select exists (select 1 from information_schema.columns where table_schema = 'public'
                 and table_name = 'scholarship_applications' and column_name = 'award_percent') as ok`),
    true,
  );
  assert.equal(
    await has(`select exists (select 1 from information_schema.columns where table_schema = 'public'
                 and table_name = 'events' and column_name = 'display_viewer_count') as ok`),
    true,
  );
});

test("the old layout, two files on 0071, fails the way the Supabase check did", async () => {
  const files = layout(SHARED_0071);
  const scholarships = files.find((f) => f.file === "0071_scholarships.sql")!;
  // Directory order put the viewer count first; it took 0071.
  assert.deepEqual(files.filter((f) => f.version === "0071").map((f) => f.file), ["0071_event_display_viewer_count.sql", "0071_scholarships.sql"]);
  const db = await supabaseProject();
  await assert.rejects(push(db, files), (err: unknown) => {
    assert.ok(err instanceof CliError, String(err));
    assert.equal(err.file, "0071_scholarships.sql");
    assert.equal(err.code, "23505");
    // The check's own words: "At statement: 32", the history INSERT after the file's 32 statements.
    assert.equal(err.statement, scholarships.statements.length);
    assert.equal(err.statement, 32);
    return true;
  });
  await db.close();
});

test("production's history: only 0078 is pending; it changes nothing there, and `migration repair` alone settles it", async () => {
  const files = layout();
  // Production ran both September files and recorded 0071 once, for
  // scholarships; it has never recorded 0078. That's the fresh database with
  // 0078's row taken out.
  const prod = fresh;
  await prod.exec(`delete from supabase_migrations.schema_migrations where version = '0078'`);
  const viewerCount = async () =>
    (
      await prod.query<{ cols: number; checks: number }>(`
        select (select count(*)::int from information_schema.columns
                 where table_schema = 'public' and table_name = 'events' and column_name = 'display_viewer_count') as cols,
               (select count(*)::int from pg_constraint where conname = 'events_display_viewer_count_check') as checks`)
    ).rows[0];
  assert.deepEqual(await viewerCount(), { cols: 1, checks: 1 });

  // Before the rename, every push to main re-ran 0071_scholarships out of
  // order and failed on its INSERT (rolled back: nothing changed).
  const before = layout(SHARED_0071);
  assert.deepEqual(cliPending(before, await recorded(prod)).map((f) => f.file), ["0071_scholarships.sql"]);
  await assert.rejects(push(prod, before), (err: unknown) => err instanceof CliError && err.code === "23505");

  // After it, 0078 is the only file the integration would run, out of order.
  assert.deepEqual(cliPending(files, await recorded(prod)).map((f) => f.file), ["0078_event_display_viewer_count.sql"]);

  // The repair route (prod_steps): record it without running anything.
  await repairApplied(prod, files, "0078");
  assert.deepEqual(cliPending(files, await recorded(prod)), []);
  assert.deepEqual(await push(prod, files), []);

  // And if the integration gets there first, running it is harmless: every
  // statement is guarded, so the column and its check stay exactly as they were.
  await prod.exec(`delete from supabase_migrations.schema_migrations where version = '0078'`);
  assert.deepEqual(await push(prod, files), ["0078_event_display_viewer_count.sql"]);
  assert.deepEqual(await viewerCount(), { cols: 1, checks: 1 });
  assert.deepEqual(await recorded(prod), files.map((f) => f.version));
  await prod.close();
});
