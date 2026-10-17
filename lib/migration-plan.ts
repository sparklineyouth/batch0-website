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

export type MigrationStatus = "applied" | "unrecorded" | "pending" | "gap";

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
               where pubname = 'supabase_realtime' and tablename = 'chat_messages')
   -- The newest pieces, so a database that ran an earlier draft of 0101
   -- reads as not done, and gets 0101 again (it's idempotent).
   and to_regclass('public.chat_mutes') is not null
   and to_regprocedure('public.chat_files_in_use(text[])') is not null
   and to_regprocedure('public.chat_counts_as_message(text, text)') is not null
   and not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'chat_reports')
   and exists (select 1 from public.site_settings where key = 'chat_history_carried') as ok;`,
  "0102": `select exists (select 1 from pg_index ix
               join pg_attribute a on a.attrelid = ix.indrelid and a.attnum = ix.indkey[0]
               where ix.indrelid = to_regclass('public.email_outbox')
                 and ix.indisunique and ix.indpred is null and ix.indnkeyatts = 1
                 and a.attname = 'dedupe_key') as ok;`,
  "0103": `select to_regprocedure('public.admin_move_student_cohort(uuid, uuid, uuid)') is not null
   and exists (select 1 from pg_trigger
               where tgrelid = to_regclass('public.profiles') and tgname = 'keep_a_full_admin')
   and exists (select 1 from pg_trigger
               where tgrelid = to_regclass('public.app_roles') and tgname = 'keep_a_full_admin_role') as ok;`,
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

type Piece = { kind: "code" | "string" | "comment"; text: string; nested: boolean };

/**
 * Split SQL into code, string literals and comments: '…' (with ''), E'…'
 * (with backslash escapes too), "identifiers", line and block comments, and dollar quotes.
 * A dollar-quoted body after DO or AS is code (a DO block or a function
 * body) and is lexed again, marked nested; anywhere else ($t$…$t$ in a
 * replace()) it's a string.
 */
export function lexSql(sql: string, nested = false): Piece[] {
  const out: Piece[] = [];
  let code = "";
  // The code seen most recently, across comments: what decides whether a
  // dollar quote opens a body (`do $$`, `as $fn$`) or a string.
  let recent = "";
  const flush = () => {
    if (code) {
      out.push({ kind: "code", text: code, nested });
      recent = (recent + code).slice(-64);
    }
    code = "";
  };
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === "-" && next === "-") {
      flush();
      let j = i;
      while (j < sql.length && sql[j] !== "\n") j++;
      out.push({ kind: "comment", text: sql.slice(i, j), nested });
      i = j;
    } else if (c === "/" && next === "*") {
      flush();
      const end = sql.indexOf("*/", i + 2);
      const j = end === -1 ? sql.length : end + 2;
      out.push({ kind: "comment", text: sql.slice(i, j), nested });
      i = j;
    } else if (c === "'") {
      flush();
      recent = "";
      const escapes = /[eE]$/.test(sql.slice(Math.max(0, i - 1), i)) && !/\w/.test(sql[i - 2] ?? "");
      let j = i + 1;
      while (j < sql.length) {
        if (escapes && sql[j] === "\\") j += 2;
        else if (sql[j] === "'" && sql[j + 1] === "'") j += 2;
        else if (sql[j] === "'") break;
        else j++;
      }
      out.push({ kind: "string", text: sql.slice(i, j + 1), nested });
      i = j + 1;
    } else if (c === '"') {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === '"' && sql[j + 1] === '"') j += 2;
        else if (sql[j] === '"') break;
        else j++;
      }
      code += sql.slice(i, j + 1);
      i = j + 1;
    } else if (c === "$" && !/\w/.test(sql[i - 1] ?? "")) {
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (!tag) {
        code += c;
        i++;
        continue;
      }
      const delim = tag[0];
      const close = sql.indexOf(delim, i + delim.length);
      const bodyEnd = close === -1 ? sql.length : close;
      const body = sql.slice(i + delim.length, bodyEnd);
      const isCode = /\b(?:do|as)\s*$/i.test((recent + code).slice(-64));
      if (isCode) {
        code += delim;
        flush();
        out.push(...lexSql(body, true));
        code += close === -1 ? "" : delim;
      } else {
        flush();
        out.push({ kind: "string", text: sql.slice(i, close === -1 ? sql.length : close + delim.length), nested });
      }
      i = close === -1 ? sql.length : close + delim.length;
    } else {
      code += c;
      i++;
    }
  }
  flush();
  return out;
}

/** SQL with comments removed (strings kept), so a word in a comment never counts. */
export function stripSqlComments(sql: string): string {
  return lexSql(sql)
    .map((p) => (p.kind === "comment" ? " " : p.text))
    .join("");
}

/** Only the code: comments and string literals blanked, so neither can look like a statement. */
function codeOnly(sql: string, topLevelOnly = false): string {
  return lexSql(sql)
    .map((p) => (p.kind === "code" && (!topLevelOnly || !p.nested) ? p.text : " "))
    .join("");
}

/**
 * The file's top-level statements, for running one at a time (Postgres runs
 * a multi-statement string as one implicit transaction, which CONCURRENTLY
 * refuses). Semicolons inside strings, comments and DO/function bodies don't split.
 */
export function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (const p of lexSql(sql)) {
    if (p.kind !== "code" || p.nested) {
      cur += p.text;
      continue;
    }
    let rest = p.text;
    let k = rest.indexOf(";");
    while (k !== -1) {
      cur += rest.slice(0, k + 1);
      if (cur.trim().replace(/;$/, "").trim()) out.push(cur.trim());
      cur = "";
      rest = rest.slice(k + 1);
      k = rest.indexOf(";");
    }
    cur += rest;
  }
  if (stripSqlComments(cur).trim()) out.push(cur.trim());
  return out;
}

/** Tables in `public` this migration creates (not temp tables). */
export function createdTables(sql: string): string[] {
  const body = codeOnly(sql);
  const re = /\bcreate\s+(?:unlogged\s+)?table\s+(?:if\s+not\s+exists\s+)?(?:(?:"?(\w+)"?)\.)?"?(\w+)"?/gi;
  const out = new Set<string>();
  for (const m of body.matchAll(re)) {
    const schema = (m[1] ?? "public").toLowerCase();
    if (schema === "public") out.add(m[2].toLowerCase());
  }
  return Array.from(out);
}

/** Tables in `public` this migration drops. */
export function droppedTables(sql: string): string[] {
  const body = codeOnly(sql);
  const out = new Set<string>();
  for (const m of body.matchAll(/\bdrop\s+table\s+(?:if\s+exists\s+)?([^;]+)/gi)) {
    for (const part of m[1].split(",")) {
      const n = /^\s*(?:"?(\w+)"?\.)?"?(\w+)"?/.exec(part);
      if (n && (n[1] ?? "public").toLowerCase() === "public") out.add(n[2].toLowerCase());
    }
  }
  return Array.from(out);
}

/**
 * How to run a file: "wrap" it in one transaction (the default — all or
 * nothing), run it as written when it manages its own ("own": a top-level
 * BEGIN … COMMIT), or statement by statement outside any transaction
 * ("none": CONCURRENTLY, which Postgres refuses inside one). Only code
 * counts: the word in a lesson's text or a comment changes nothing.
 */
export function transactionMode(sql: string): "wrap" | "own" | "none" {
  const top = codeOnly(sql, true);
  if (/\bconcurrently\b/i.test(top)) return "none";
  if (/(?:^|;)\s*(?:begin|start\s+transaction)\s*;/i.test(top) && /(?:^|;)\s*commit\s*;/i.test(top)) return "own";
  return "wrap";
}

/**
 * What a migration removes or rewrites, so it can be snapshotted first:
 * tables it drops, tables it drops columns from, and tables it updates or
 * deletes from — top level or inside DO blocks. Only `public`; dynamic SQL
 * built from strings isn't seen.
 */
export function touchedTables(sql: string): string[] {
  const body = codeOnly(sql);
  const out = new Set<string>(droppedTables(sql));
  const add = (schema: string | undefined, name: string) => {
    if ((schema ?? "public").toLowerCase() === "public") out.add(name.toLowerCase());
  };
  const name = String.raw`(?:"?(\w+)"?\.)?"?(\w+)"?`;
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

/**
 * Checks that test for an absence ("no write policy left", "no role holds
 * this key"). A pass can't prove the file ran — a database that never had
 * the thing passes too — so it's never evidence for anything else, and the
 * file itself counts as live only when a later file proves it ran. These
 * files are idempotent, so running one again is safe.
 */
export const ABSENCE_CHECKS: ReadonlySet<string> = new Set(["0097", "0099", "0100"]);

/**
 * Decide, file by file, from that file's OWN evidence:
 *
 *   recorded        in supabase_migrations (for a version two files share,
 *                   a file that creates tables also needs them to exist)
 *   positive check  its verify query passes (or fails: pending)
 *   own tables      every table it creates exists (that no later file drops)
 *
 * A file with no evidence of its own either way (it creates no tables, or a
 * later file dropped them, or its check is an absence check) counts as live
 * only if some later file has positive evidence; else it's pending.
 *
 * A file whose own evidence says "missing" while a later file's says
 * "applied" is a GAP: the history skipped it. The runner stops on gaps
 * instead of guessing — running an old, non-idempotent file late can do
 * damage, and recording it unrun would hide the hole forever.
 */
export function planMigrations(files: readonly MigrationFile[], state: DbState): PlannedMigration[] {
  const sorted = sortMigrations(files);
  const hasCheck = (v: string) => Object.prototype.hasOwnProperty.call(MIGRATION_CHECKS, v);
  const missingFor = (v: string) => (CHECK_REQUIRES[v] ?? []).filter((t) => !state.existingTables.has(t));
  const checkPasses = (v: string) => state.checks.get(v) === true && missingFor(v).length === 0;
  const versionCount = new Map<string, number>();
  for (const f of sorted) versionCount.set(f.version, (versionCount.get(f.version) ?? 0) + 1);

  // Tables each file creates that no later file drops: those must still exist if it ran.
  const droppedAfter: Set<string>[] = sorted.map(() => new Set());
  for (let i = sorted.length - 2; i >= 0; i--) {
    droppedAfter[i] = new Set([...droppedAfter[i + 1], ...droppedTables(sorted[i + 1].sql)]);
  }
  const ownTables = sorted.map((f, i) => createdTables(f.sql).filter((t) => !droppedAfter[i].has(t)));

  /** true: it ran; false: it didn't; null: this file can't tell. */
  const own = (f: MigrationFile, i: number): boolean | null => {
    const tables = ownTables[i];
    const tablesSay = tables.length ? tables.every((t) => state.existingTables.has(t)) : null;
    if (state.recorded?.has(f.version)) {
      // A shared version proves only that one of its files ran.
      if ((versionCount.get(f.version) ?? 0) > 1 && tablesSay === false) return false;
      // The newest file is recorded but its verify query fails: an earlier
      // draft of it ran (a branch's migration, edited since). Nothing after
      // it can depend on the draft, and the October files are idempotent, so
      // it runs again. Only the newest: an older file's check can fail for
      // what a later file changed on purpose.
      if (i === sorted.length - 1 && hasCheck(f.version) && !ABSENCE_CHECKS.has(f.version) && !checkPasses(f.version)) {
        return false;
      }
      return true;
    }
    if (hasCheck(f.version)) {
      if (ABSENCE_CHECKS.has(f.version)) return null;
      return checkPasses(f.version);
    }
    return tablesSay;
  };
  const evidence = sorted.map((f, i) => own(f, i));
  const laterRan: boolean[] = sorted.map(() => false);
  for (let i = sorted.length - 2; i >= 0; i--) laterRan[i] = laterRan[i + 1] || evidence[i + 1] === true;

  return sorted.map((f, i) => {
    const e = evidence[i];
    if (state.recorded?.has(f.version) && e !== false) return { ...f, status: "applied" as const, why: "recorded in supabase_migrations" };
    if (e === true) {
      return hasCheck(f.version)
        ? { ...f, status: "unrecorded" as const, why: "its verify query passes" }
        : { ...f, status: "unrecorded" as const, why: "every table it creates exists" };
    }
    if (e === null) {
      if (laterRan[i]) {
        const why = ABSENCE_CHECKS.has(f.version) && checkPasses(f.version) ? "its verify query passes and a later file ran" : "a later migration has run";
        return { ...f, status: "unrecorded" as const, why };
      }
      if (ABSENCE_CHECKS.has(f.version)) {
        const missing = missingFor(f.version);
        return {
          ...f,
          status: "pending" as const,
          why: missing.length ? `its verify query can't tell yet (${missing.join(", ")} missing)` : "its verify query can't prove it ran (safe to run again)",
        };
      }
      return { ...f, status: "pending" as const, why: "nothing shows it has run" };
    }
    // Its own evidence says it hasn't run.
    const missingTables = ownTables[i].filter((t) => !state.existingTables.has(t));
    const why = hasCheck(f.version)
      ? state.recorded?.has(f.version)
        ? "recorded, but its verify query fails: an earlier draft of it ran, so it runs again"
        : "its verify query fails"
      : state.recorded?.has(f.version)
        ? `recorded, but its tables are missing (${missingTables.join(", ")}) — version ${f.version} is shared`
        : `its tables are missing (${missingTables.join(", ")})`;
    // Out of order: a later file ran. The October files (verify queries) are
    // idempotent and documented to run out of order, so they're plain pending.
    if (laterRan[i] && !hasCheck(f.version)) return { ...f, status: "gap" as const, why: `${why}, though later files ran` };
    return { ...f, status: "pending" as const, why };
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
  // Supavisor (*.pooler.supabase.com) and the dedicated PgBouncer
  // (db.<ref>.supabase.co) both pool in transaction mode on 6543.
  if (/\.supabase\.(?:com|co)$/i.test(parsed.hostname) && parsed.port === "6543") {
    parsed.port = "5432";
    return { url: parsed.toString(), changed: true };
  }
  return { url, changed: false };
}

/** Postgres error codes that mean "that object doesn't exist" — a verify query saying "not yet". */
export const MISSING_OBJECT_CODES: ReadonlySet<string> = new Set(["42P01", "42703", "3F000", "42883", "42704"]);
