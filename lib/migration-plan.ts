/**
 * Which migrations a database still needs, in what order, and how to run each
 * one — the pure half of `npm run db:migrate` (scripts/db-migrate.mts). Pure:
 * no database, no filesystem, so `node --test` runs it as-is.
 *
 * Production's migrations were mostly run by hand in the Supabase SQL editor,
 * so `supabase_migrations.schema_migrations` (what `supabase db push` reads)
 * can't be trusted alone: a migration may be live but unrecorded, and pushing
 * would run it again. A migration counts as applied when any of these holds:
 *
 *   1. it's recorded in supabase_migrations.schema_migrations;
 *   2. it has a verify query (MIGRATION_CHECKS, the same queries as
 *      docs/migrations-2026-10.md) and that query passes;
 *   3. it has no verify query, and some migration at or after it shows it
 *      ran: recorded, verified, or every table it creates exists. Migrations
 *      run in order, so a later one having run means this one did too — and
 *      that also covers a migration whose tables a later one dropped (0033's
 *      Discord tables, dropped by 0101).
 *
 * Anything else is pending and runs in file order.
 */

export type MigrationFile = {
  /** "0101_chat.sql" */
  file: string;
  /** "0101" — what the Supabase CLI records. Two files can share one (0071). */
  version: string;
  num: number;
  sql: string;
};

export type MigrationStatus = "applied" | "unrecorded" | "pending";

export type PlannedMigration = MigrationFile & { status: MigrationStatus; why: string };

/**
 * One row, `ok = true`, once the migration has run. Copied verbatim from the
 * Verify section of docs/migrations-2026-10.md; lib/migration-plan.test.ts
 * fails if the two drift apart.
 */
export const MIGRATION_CHECKS: Readonly<Record<string, string>> = {
  "0093": `select to_regclass('public.course_assignments') is not null
   and to_regclass('public.course_assignment_targets') is not null
   and to_regclass('public.course_assignment_submissions') is not null as ok;`,
  "0094": `select to_regclass('public.team_drive_links') is not null
   and exists (select 1 from information_schema.columns
               where table_schema = 'public' and table_name = 'pitch_submissions'
                 and column_name = 'deck_url') as ok;`,
  "0095": `select (select count(*) from information_schema.columns
        where table_schema = 'public' and table_name = 'recording_sessions'
          and column_name in ('end_reason', 'finalize_attempts')) = 2
   and exists (select 1 from storage.buckets
               where id = 'recordings' and file_size_limit = 16777216) as ok;`,
  "0096": `select exists (select 1 from information_schema.columns
               where table_schema = 'public' and table_name = 'events'
                 and column_name = 'live_primary_host_id') as ok;`,
  "0097": `select count(*) = 0 as ok from pg_policies
where schemaname = 'public'
  and tablename in ('call_invites', 'interview_requests', 'mentor_bookings', 'mentor_slots')
  and cmd <> 'SELECT';`,
  "0098": `select exists (select 1 from pg_policies
               where schemaname = 'public' and tablename = 'events'
                 and policyname = 'events staff write'
                 and qual like '%events.manage%') as ok;`,
  "0099": `select count(*) = 0 as ok from pg_policies
where schemaname = 'public'
  and tablename in ('discussion_threads', 'discussion_replies', 'team_messages',
                    'announcement_reactions', 'lesson_comments')
  and cmd <> 'SELECT';`,
  "0100": `select count(*) = 0 as ok from public.app_roles
where permissions @> array['ai_usage.view']::text[];`,
  "0101": `select to_regclass('public.chat_channels') is not null
   and to_regclass('public.chat_message_revisions') is not null
   and exists (select 1 from public.chat_channels where system_key = 'general')
   and not exists (select 1 from information_schema.columns
                   where table_schema = 'public' and table_name = 'profiles'
                     and column_name like 'discord%')
   and not exists (select 1 from public.app_roles
                   where permissions @> array['discord.manage']::text[])
   and exists (select 1 from pg_publication_tables
               where pubname = 'supabase_realtime' and tablename = 'chat_messages') as ok;`,
};

/**
 * Tables a verify query is about, for the queries that check for an absence
 * ("no write policy left on these tables", "no role holds this key"). Those
 * pass vacuously on a database that doesn't have the tables yet, so a pass
 * only counts once every table here exists.
 */
export const CHECK_REQUIRES: Readonly<Record<string, readonly string[]>> = {
  "0097": ["call_invites", "interview_requests", "mentor_bookings", "mentor_slots"],
  "0099": ["discussion_threads", "discussion_replies", "team_messages", "announcement_reactions", "lesson_comments"],
  "0100": ["app_roles"],
  "0101": ["profiles", "app_roles"],
};

/**
 * Migrations that may only run once the code that no longer needs what they
 * remove is live. Checked over HTTP: a redirect only the new code has.
 */
export const DEPLOY_GATES: Readonly<Record<string, { path: string; expectLocation: string; why: string }>> = {
  "0101": {
    path: "/admin/discord",
    expectLocation: "/admin/chat",
    why: "0101 drops the Discord columns and tables the previous code reads, so the Chat code has to be live first",
  },
};

const VERSION_RE = /^(\d{4})_[\w.-]+\.sql$/;

export function parseMigrationFile(file: string, sql: string): MigrationFile | null {
  const m = VERSION_RE.exec(file);
  if (!m) return null;
  return { file, version: m[1], num: Number(m[1]), sql };
}

export function sortMigrations<T extends Pick<MigrationFile, "num" | "file">>(files: readonly T[]): T[] {
  return [...files].sort((a, b) => a.num - b.num || a.file.localeCompare(b.file));
}

/** SQL with comments blanked out, so a word in a comment never counts. Strings are kept. */
export function stripSqlComments(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === "'") {
      // A string literal, '' escapes included.
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'" && sql[j + 1] === "'") j += 2;
        else if (sql[j] === "'") break;
        else j++;
      }
      out += sql.slice(i, j + 1);
      i = j + 1;
    } else if (c === "-" && next === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
    } else if (c === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 2;
      out += " ";
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** Tables in `public` this migration creates (not temp tables). */
export function createdTables(sql: string): string[] {
  const body = stripSqlComments(sql);
  const re = /\bcreate\s+(?:unlogged\s+)?table\s+(?:if\s+not\s+exists\s+)?(?:(?:"?(\w+)"?)\.)?"?(\w+)"?/gi;
  const out = new Set<string>();
  for (const m of body.matchAll(re)) {
    const schema = (m[1] ?? "public").toLowerCase();
    if (schema === "public") out.add(m[2].toLowerCase());
  }
  return Array.from(out);
}

/**
 * How to run a file: "wrap" it in one transaction (the default — all or
 * nothing), run it as written when it manages its own ("own": a top-level
 * BEGIN … COMMIT), or outside any transaction ("none": CONCURRENTLY, which
 * Postgres refuses inside one).
 */
export function transactionMode(sql: string): "wrap" | "own" | "none" {
  const body = stripSqlComments(sql);
  if (/\bconcurrently\b/i.test(body)) return "none";
  if (/^\s*(?:begin|start\s+transaction)\s*;/im.test(body) && /^\s*commit\s*;/im.test(body)) return "own";
  return "wrap";
}

/**
 * What a migration removes or rewrites, so it can be snapshotted first:
 * tables it drops, tables it drops columns from, and tables it updates or
 * deletes from. Only `public`, only statements written out (not dynamic SQL).
 */
export function touchedTables(sql: string): string[] {
  const body = stripSqlComments(sql);
  const out = new Set<string>();
  const add = (schema: string | undefined, name: string) => {
    if ((schema ?? "public").toLowerCase() === "public") out.add(name.toLowerCase());
  };
  const name = String.raw`(?:"?(\w+)"?\.)?"?(\w+)"?`;
  for (const m of body.matchAll(new RegExp(String.raw`\bdrop\s+table\s+(?:if\s+exists\s+)?${name}`, "gi"))) add(m[1], m[2]);
  for (const m of body.matchAll(new RegExp(String.raw`\balter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?${name}[^;]*?\bdrop\s+column\b`, "gi"))) add(m[1], m[2]);
  for (const m of body.matchAll(new RegExp(String.raw`\bupdate\s+(?:only\s+)?${name}\s+(?:as\s+)?(?:\w+\s+)?set\b`, "gi"))) add(m[1], m[2]);
  for (const m of body.matchAll(new RegExp(String.raw`\bdelete\s+from\s+(?:only\s+)?${name}`, "gi"))) add(m[1], m[2]);
  return Array.from(out);
}

export type DbState = {
  /** Versions in supabase_migrations.schema_migrations; null when that table doesn't exist. */
  recorded: ReadonlySet<string> | null;
  /** Verify query results by version (only versions with a check). */
  checks: ReadonlyMap<string, boolean>;
  /** Tables that exist in `public`. */
  existingTables: ReadonlySet<string>;
};

export function planMigrations(files: readonly MigrationFile[], state: DbState): PlannedMigration[] {
  const sorted = sortMigrations(files);
  const hasCheck = (v: string) => Object.prototype.hasOwnProperty.call(MIGRATION_CHECKS, v);
  const missingFor = (v: string) => (CHECK_REQUIRES[v] ?? []).filter((t) => !state.existingTables.has(t));
  const checkPasses = (v: string) => state.checks.get(v) === true && missingFor(v).length === 0;

  // The newest migration with positive evidence that it ran.
  let evidence = -1;
  for (const f of sorted) {
    const recorded = !!state.recorded?.has(f.version);
    let ran = recorded;
    if (!ran && hasCheck(f.version)) ran = checkPasses(f.version);
    else if (!ran) {
      const tables = createdTables(f.sql);
      ran = tables.length > 0 && tables.every((t) => state.existingTables.has(t));
    }
    if (ran) evidence = Math.max(evidence, f.num);
  }

  return sorted.map((f) => {
    if (state.recorded?.has(f.version)) return { ...f, status: "applied" as const, why: "recorded in supabase_migrations" };
    if (hasCheck(f.version)) {
      if (checkPasses(f.version)) return { ...f, status: "unrecorded" as const, why: "its verify query passes" };
      const missing = missingFor(f.version);
      return state.checks.get(f.version) === true && missing.length
        ? { ...f, status: "pending" as const, why: `its verify query can't tell yet (${missing.join(", ")} missing)` }
        : { ...f, status: "pending" as const, why: "its verify query fails" };
    }
    if (f.num <= evidence) {
      const tables = createdTables(f.sql);
      const own = tables.length > 0 && tables.every((t) => state.existingTables.has(t));
      return { ...f, status: "unrecorded" as const, why: own ? "every table it creates exists" : "a later migration has run" };
    }
    return { ...f, status: "pending" as const, why: "nothing shows it has run" };
  });
}

/** The project ref a Supabase URL or Postgres connection string points at, if it says. */
export function supabaseProjectRef(url: string | undefined | null): string | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  // https://<ref>.supabase.co, db.<ref>.supabase.co
  const direct = /^(?:db\.)?([a-z0-9]{20})\.supabase\.(?:co|com)$/.exec(host);
  if (direct) return direct[1];
  // Supavisor pooler: user is postgres.<ref>
  if (/pooler\.supabase\.com$/.test(host)) {
    const user = decodeURIComponent(parsed.username);
    const m = /^[a-z_]+\.([a-z0-9]{20})$/.exec(user);
    if (m) return m[1];
  }
  return null;
}

/**
 * The connection string to use: the pooler's transaction port (6543) can't
 * hold the session the run needs (an advisory lock, one transaction per file),
 * so it's moved to the session port (5432) on the same host.
 */
export function sessionConnectionString(url: string): { url: string; changed: boolean } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { url, changed: false };
  }
  if (/pooler\.supabase\.com$/i.test(parsed.hostname) && parsed.port === "6543") {
    parsed.port = "5432";
    return { url: parsed.toString(), changed: true };
  }
  return { url, changed: false };
}

/** Postgres error codes that mean "that object doesn't exist" — a verify query saying "not yet". */
export const MISSING_OBJECT_CODES: ReadonlySet<string> = new Set(["42P01", "42703", "3F000", "42883", "42704"]);
