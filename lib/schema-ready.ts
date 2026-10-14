// Server-only helper. Detects "relation/column does not exist" so features shipped ahead of their
// migration degrade instead of 500ing.
//
// Production gets new code before the matching migration is run by hand, so any read or write of a
// new table or column must treat these errors as "not set up yet" rather than as a failure.
//   42P01     Postgres: undefined table
//   42703     Postgres: undefined column
//   PGRST205  PostgREST: table not in the schema cache
//   PGRST204  PostgREST: column not in the schema cache
export function isMissingSchemaError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: unknown; message?: unknown };
  const code = typeof e.code === "string" ? e.code : "";
  if (
    code === "42P01" ||
    code === "42703" ||
    code === "PGRST205" ||
    code === "PGRST204"
  ) {
    return true;
  }
  const message = typeof e.message === "string" ? e.message : "";
  return /does not exist|could not find the/i.test(message);
}
