import "server-only";
import { NextResponse } from "next/server";
import { isMissingSchemaError } from "@/lib/schema-ready";
import { asUuid } from "@/lib/chat-access";
import { currentReader, type Reader } from "./reads";

/**
 * The GET routes' one answer shape: `{ ok: true, data }`, or `{ ok: false,
 * error }` with a 4xx when the server is saying no (401 signed out, 400 a bad
 * request, 404 not available) and a 200 when something underneath failed and
 * a retry may work. Never a 500, never cached: every answer is one person's,
 * as of now.
 */

const NO_STORE = { "cache-control": "no-store" };

export const READ_FAILED = "Couldn't load that. Try again in a moment.";
export const NOT_AVAILABLE = "That conversation isn't available. It may not exist, or you may not be in it.";

export function ok<T>(data: T): NextResponse {
  return NextResponse.json({ ok: true, data }, { headers: NO_STORE });
}

export function fail(status: 200 | 400 | 401 | 404, error: string): NextResponse {
  return NextResponse.json({ ok: false, error }, { status, headers: NO_STORE });
}

/**
 * Run a read for the signed-in person. `run` returns the data, or null for
 * "not available" (404). Anything thrown is logged and answered as a
 * retryable failure — before migration 0101, with a "not set up" message.
 */
export async function answer<T>(name: string, run: (reader: Reader) => Promise<T | null>): Promise<NextResponse> {
  try {
    const reader = await currentReader();
    if (!reader) return fail(401, "Sign in to use chat.");
    const data = await run(reader);
    return data === null ? fail(404, NOT_AVAILABLE) : ok(data);
  } catch (err) {
    if (isMissingSchemaError(err)) return fail(200, "Chat isn't set up yet.");
    console.error(`[chat/api/${name}]`, err);
    return fail(200, READ_FAILED);
  }
}

/** A required channel id from the query string, or null. */
export function channelParam(url: URL): string | null {
  return asUuid(url.searchParams.get("c"));
}
