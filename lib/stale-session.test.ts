import test from "node:test";
import assert from "node:assert/strict";
import * as nodeModule from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";
import {
  classifyClaimsError,
  isStaleSessionError,
  quietStaleSessionLogs,
  STALE_SESSION_CODES,
} from "./stale-session.ts";

// Run with `npm test`. The pure rules first, then the real middleware
// (lib/supabase/middleware.ts) with the real @supabase/ssr and auth-js
// against a fake auth server — the production symptom was a library
// interaction, so a double of the library would prove nothing. No network:
// global fetch is replaced before anything can call it.

/** Shaped like auth-js's AuthApiError: the brand, a code, a status. */
function authError(code: string, status = 400) {
  return Object.assign(new Error(`auth: ${code}`), { __isAuthError: true, code, status });
}

test("a session that ended is signed out, not an incident", () => {
  for (const code of STALE_SESSION_CODES) {
    assert.equal(isStaleSessionError(authError(code)), true, code);
    assert.equal(classifyClaimsError(authError(code)), "signed-out", code);
  }
});

test("a token the server refused is rejected; everything else is transient", () => {
  assert.equal(classifyClaimsError(authError("bad_jwt", 401)), "rejected");
  assert.equal(classifyClaimsError(authError("not_admin", 403)), "rejected");
  // The rotation race this app causes itself: the visitor is usually still
  // signed in through whichever parallel request won.
  assert.equal(classifyClaimsError(authError("refresh_token_already_used")), "transient");
  assert.equal(classifyClaimsError({ __isAuthError: true, status: 503 }), "transient");
  assert.equal(classifyClaimsError(new Error("fetch failed")), "transient");
  assert.equal(classifyClaimsError(null), "transient");
});

test("only auth-js's own errors count — not a lookalike without the brand", () => {
  assert.equal(isStaleSessionError({ code: "refresh_token_not_found" }), false);
  assert.equal(isStaleSessionError("refresh_token_not_found"), false);
  assert.equal(isStaleSessionError(undefined), false);
});

test("the log filter drops exactly auth-js's bare stale-session line", () => {
  const seen: unknown[][] = [];
  const sink = { error: (...args: unknown[]) => void seen.push(args) };
  quietStaleSessionLogs(sink);
  quietStaleSessionLogs(sink); // idempotent: one wrapper, not two

  sink.error(authError("refresh_token_not_found")); // dropped
  sink.error("[middleware] getClaims failed on /x:", 400, "msg"); // ours: kept
  sink.error(authError("refresh_token_already_used")); // a different error: kept
  sink.error("context", authError("refresh_token_not_found")); // two args: kept
  sink.error(new Error("unrelated")); // kept
  assert.equal(seen.length, 4);
  assert.equal(seen[0][0], "[middleware] getClaims failed on /x:");
});

// ---------------------------------------------------------------------------
// The real middleware
// ---------------------------------------------------------------------------

const REF = "abcdefghijklmnop";
process.env.NEXT_PUBLIC_SUPABASE_URL = `https://${REF}.supabase.co`;
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-test-key";
const COOKIE = `sb-${REF}-auth-token`;

// Every console.error the middleware or the auth libraries make lands here.
// Installed before the middleware module loads, because that is when its
// filter wraps whatever console.error is.
const logged: unknown[][] = [];
console.error = (...args: unknown[]) => void logged.push(args);

// What the fake auth server answers a refresh with.
let refreshReply: { status: number; body: Record<string, unknown> } = { status: 200, body: {} };
const calls: string[] = [];
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = String(input instanceof Request ? input.url : input);
  calls.push(url);
  if (url.includes("/auth/v1/token")) {
    return new Response(JSON.stringify(refreshReply.body), {
      status: refreshReply.status,
      headers: { "content-type": "application/json", "x-supabase-api-version": "2024-01-01" },
    });
  }
  throw new Error(`unexpected fetch in middleware test: ${url}`);
}) as typeof fetch;

const root = fileURLToPath(new URL("../", import.meta.url));
(nodeModule as any).registerHooks({
  resolve(specifier: string, context: any, next: any) {
    // `next` has no exports map, so ESM needs the file name spelled out.
    if (specifier === "next/server") return next("next/server.js", context);
    if (specifier.startsWith("@/")) {
      return next(pathToFileURL(path.join(root, specifier.slice(2) + ".ts")).href, context);
    }
    return next(specifier, context);
  },
});
const { NextRequest } = await import("next/server.js");
const { updateSession } = await import("./supabase/middleware.ts");

/** A session cookie whose access token expired an hour ago, as @supabase/ssr writes it. */
function expiredSessionCookie(): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const past = Math.floor(Date.now() / 1000) - 3600;
  const jwt = `${b64({ alg: "ES256", kid: "k1", typ: "JWT" })}.${b64({ sub: "u1", exp: past })}.sig`;
  const session = {
    access_token: jwt,
    refresh_token: "revoked-refresh-token",
    expires_at: past,
    expires_in: 3600,
    token_type: "bearer",
    user: { id: "u1" },
  };
  return `${COOKIE}=base64-${b64(session)}`;
}

function request(pathname: string) {
  return new NextRequest(`https://batch0.org${pathname}`, {
    headers: { host: "batch0.org", cookie: expiredSessionCookie() },
  });
}

function expiresAuthCookie(res: Response): boolean {
  const setCookie = res.headers.getSetCookie().find((c) => c.startsWith(`${COOKIE}=`));
  return !!setCookie && /Max-Age=0/i.test(setCookie);
}

async function settle() {
  // auth-js's INITIAL_SESSION emissions run behind the client's lock; give
  // them a turn so a line they would log is caught by this test, not the next.
  await new Promise((r) => setTimeout(r, 20));
}

const STALE = { status: 400, body: { code: "refresh_token_not_found", msg: "Invalid Refresh Token: Refresh Token Not Found" } };

test("a stale cookie on a protected page: signed out, cookie expired, nothing logged", async () => {
  logged.length = 0;
  calls.length = 0;
  refreshReply = STALE;
  const res = await updateSession(request("/dashboard/events"));
  await settle();
  assert.equal(res.status, 307);
  const to = new URL(res.headers.get("location")!);
  assert.equal(to.pathname, "/login");
  assert.equal(to.searchParams.get("next"), "/dashboard/events");
  assert.ok(expiresAuthCookie(res), "the dead cookie is expired on the redirect");
  assert.ok(calls.some((u) => u.includes("/auth/v1/token")), "the refresh really was attempted");
  assert.deepEqual(logged, [], "neither the middleware nor auth-js logged it");
});

test("a stale cookie on a page that lets signed-out visitors through: cookie expired, nothing logged", async () => {
  logged.length = 0;
  refreshReply = STALE;
  const res = await updateSession(request("/support/t/some-ticket-token"));
  await settle();
  assert.equal(res.headers.get("location"), null);
  assert.ok(expiresAuthCookie(res), "auth-js's own removal rides on the pass-through response");
  assert.deepEqual(logged, []);
});

test("an unexpected auth failure is still logged, by the middleware and by auth-js", async () => {
  logged.length = 0;
  refreshReply = { status: 400, body: { code: "refresh_token_already_used", msg: "Invalid Refresh Token: Already Used" } };
  const res = await updateSession(request("/dashboard/events"));
  await settle();
  assert.equal(res.status, 307);
  const ours = logged.find((args) => String(args[0]).startsWith("[middleware] getClaims failed on /dashboard/events"));
  assert.ok(ours, "the middleware's own line is there");
  assert.equal(ours[1], 400);
  assert.ok(
    logged.some((args) => args.length === 1 && (args[0] as any)?.code === "refresh_token_already_used"),
    "auth-js's line for a different error passes through the filter",
  );
});
