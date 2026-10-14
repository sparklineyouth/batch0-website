// Server-only helper. Detects "relation/column does not exist" so features shipped ahead of their
// migration degrade instead of 500ing.
export function isMissingSchemaError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: unknown; message?: unknown };
  const code = typeof e.code === "string" ? e.code : "";
  if (code === "42P01" || code === "42703" || code === "PGRST205" || code === "PGRST204") {
    return true;
  }
  const message = typeof e.message === "string" ? e.message : "";
  return /does not exist|could not find the/i.test(message);
}
