/**
 * Tiny CSV serializer. Quoted whenever the field contains a comma,
 * quote, newline, or carriage return — escapes embedded quotes by
 * doubling them. Treats null/undefined as the empty field. Also
 * defuses Excel/Sheets formula injection by prefixing cells that
 * begin with =, +, -, @, tab, or CR with a single quote.
 */
function escapeCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  let s = typeof v === "string" ? v : String(v);
  if (s.length > 0 && /^[=+\-@\t\r]/.test(s)) {
    s = `'${s}`;
  }
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function toCsv(headers: string[], rows: unknown[][]): string {
  const lines = [headers.map(escapeCell).join(",")];
  for (const row of rows) {
    lines.push(row.map(escapeCell).join(","));
  }
  return lines.join("\r\n");
}

export function csvResponse(name: string, csv: string) {
  // Strip CR/LF/quotes from the filename so it can't inject extra
  // Content-Disposition headers, and ASCII-fall-back via filename* per RFC 5987.
  const safe = name.replace(/[\r\n"\\]/g, "");
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(safe)}`,
      "Cache-Control": "no-store",
    },
  });
}
