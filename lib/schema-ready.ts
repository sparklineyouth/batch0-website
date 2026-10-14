// Server-only helper. Detects "relation/column does not exist" so features shipped ahead of their
// migration degrade instead of 500ing.
export function isMissingSchemaError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const { code, message } = err as { code?: unknown; message?: unknown };
  if (code === "42P01" || code === "42703" || code === "PGRST205" || code === "PGRST204") {
    return true;
  }
  return typeof message === "string" && /does not exist|could not find the/i.test(message);
}
