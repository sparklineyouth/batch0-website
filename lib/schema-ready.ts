// Server-only helper. Detects "relation/column does not exist" so features shipped ahead of their
// migration degrade instead of 500ing.

const MISSING_CODES = new Set(["42P01", "42703", "PGRST205", "PGRST204"]);

export function isMissingSchemaError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const { code, message } = err as { code?: unknown; message?: unknown };
  if (typeof code === "string" && MISSING_CODES.has(code)) return true;
  return typeof message === "string" && /does not exist|could not find the/i.test(message);
}
