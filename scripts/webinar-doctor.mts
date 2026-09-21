/**
 * Webinar doctor: is the live-video system actually able to run a webinar?
 *
 *   npm run webinar-doctor
 *
 * Provider-aware. It checks whatever `LIVE_PROVIDER` selects — batch0 Live by
 * default, Daily when opted in — plus the data every webinar depends on
 * regardless of provider.
 *
 * WHAT THIS CANNOT DO, AND WHY IT SAYS SO
 * ---------------------------------------
 * No amount of configuration checking proves a webinar works. `daily-doctor`
 * passed every one of its checks for months while hosted webinars were
 * completely broken, because it exercised the REST plane — create a room,
 * mint a token, decode the claims — and the failure was on the media plane:
 * the Daily account refuses every join with `account-missing-payment-method`.
 *
 * So this script ends by telling you to run `npm run webinar-e2e`, which
 * drives two real browsers into a real room and asserts on decoded frames.
 * That is the only check that can say "a student sees the host".
 */

import { createClient } from "@supabase/supabase-js";

const API = "https://api.daily.co/v1";

function need(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing ${name}. Run via npm so .env.local is loaded.`);
    process.exit(1);
  }
  return v;
}

const SUPABASE_URL = need("NEXT_PUBLIC_SUPABASE_URL");
const ANON = need("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const SERVICE = need("SUPABASE_SERVICE_ROLE_KEY");
const PROVIDER = process.env.LIVE_PROVIDER === "daily" ? "daily" : "builtin";

let failures = 0;
let warnings = 0;
const pass = (m: string) => console.log(`  ok    ${m}`);
const info = (m: string) => console.log(`        ${m}`);
const warn = (m: string) => {
  warnings++;
  console.log(`  warn  ${m}`);
};
function check(cond: boolean, m: string) {
  if (cond) pass(m);
  else {
    failures++;
    console.log(`  FAIL  ${m}`);
  }
}

const rest = (path: string) =>
  fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` },
  });

// ---------------------------------------------------------------------------
// batch0 Live
// ---------------------------------------------------------------------------
async function checkBuiltin() {
  console.log("\nbatch0 Live (built-in provider)");

  // The secret every channel name and host proof is derived from. Falls back
  // to the service-role key, so this only fails when Supabase itself is
  // unconfigured — but an empty secret would mean every room shared one
  // guessable key, which is worth stating rather than assuming.
  const secret = process.env.LIVE_ROOM_SECRET ?? SERVICE;
  check(!!secret && secret.length > 20, "room secret is present and non-trivial");
  info(
    process.env.LIVE_ROOM_SECRET
      ? "using LIVE_ROOM_SECRET"
      : "using SUPABASE_SERVICE_ROLE_KEY as the HMAC input (no extra env var needed)",
  );

  // Signalling: a browser-to-browser broadcast round trip. This is the exact
  // path an offer takes from host to viewer.
  const a = createClient(SUPABASE_URL, ANON);
  const b = createClient(SUPABASE_URL, ANON);
  const topic = `b0live:doctor:${Date.now().toString(36)}`;
  let got: any = null;

  const sub = a.channel(topic);
  sub.on("broadcast", { event: "b0live" }, (m) => (got = m.payload));
  const subscribed = await new Promise<boolean>((resolve) => {
    sub.subscribe((s) => {
      if (s === "SUBSCRIBED") resolve(true);
      if (s === "CHANNEL_ERROR" || s === "TIMED_OUT") resolve(false);
    });
    setTimeout(() => resolve(false), 15_000);
  });
  check(subscribed, "Supabase Realtime accepts a subscription");

  if (subscribed) {
    const t0 = Date.now();
    const pub = b.channel(topic);
    await new Promise<void>((resolve) => {
      pub.subscribe((s) => s === "SUBSCRIBED" && resolve());
      setTimeout(resolve, 10_000);
    });
    await pub.send({
      type: "broadcast",
      event: "b0live",
      payload: { t: "doctor" },
    });
    for (let i = 0; i < 60 && !got; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    check(!!got, "client-to-client signalling round trip (host <-> viewer)");
    if (got) info(`round trip ${Date.now() - t0}ms`);
  }

  // The server-side publish that delivers a viewer's arrival to the hosts.
  // A viewer never holds the lobby key, so this path is how it reaches them.
  let serverGot: any = null;
  const lobby = a.channel(`${topic}:lobby`);
  lobby.on("broadcast", { event: "b0live" }, (m) => (serverGot = m.payload));
  await new Promise<void>((resolve) => {
    lobby.subscribe((s) => s === "SUBSCRIBED" && resolve());
    setTimeout(resolve, 10_000);
  });
  const res = await fetch(`${SUPABASE_URL}/realtime/v1/api/broadcast`, {
    method: "POST",
    headers: {
      apikey: SERVICE,
      Authorization: `Bearer ${SERVICE}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messages: [
        { topic: `${topic}:lobby`, event: "b0live", payload: { t: "doctor" } },
      ],
    }),
  });
  check(res.ok, `server-side broadcast accepted (HTTP ${res.status})`);
  for (let i = 0; i < 60 && !serverGot; i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  check(!!serverGot, "server-to-host lobby delivery (how arrivals reach a host)");

  await a.removeAllChannels().catch(() => {});
  await b.removeAllChannels().catch(() => {});

  // TURN. Optional, and genuinely optional — most home and school networks
  // connect over STUN alone — but the failure mode without it is specific
  // and worth naming rather than discovering live.
  const turn = (process.env.LIVE_TURN_URLS ?? "").trim();
  if (turn) {
    pass(`TURN relay configured (${turn.split(",").length} URL(s))`);
    if (!process.env.LIVE_TURN_USERNAME || !process.env.LIVE_TURN_CREDENTIAL) {
      warn("LIVE_TURN_URLS is set but username/credential are not — most TURN servers will refuse");
    }
  } else {
    warn("no TURN relay (LIVE_TURN_URLS unset)");
    info("STUN alone covers most home and school networks. Viewers behind a");
    info("symmetric NAT or a strict corporate firewall will fail to connect.");
  }

  // Attendance is best-effort by design: discovery runs entirely over
  // Realtime, so a missing table costs the record and not the webinar.
  const table = await rest("live_participants?select=id&limit=1");
  if (table.ok) {
    pass("live_participants table present — attendance is being recorded");
  } else {
    warn("live_participants missing — webinars still work, attendance is not recorded");
    info("Apply supabase/migrations/0076_builtin_live.sql to turn it on.");
  }
}

// ---------------------------------------------------------------------------
// Daily
// ---------------------------------------------------------------------------
async function checkDaily() {
  console.log("\nDaily (LIVE_PROVIDER=daily)");
  const key = process.env.DAILY_API_KEY;
  const domain = process.env.NEXT_PUBLIC_DAILY_DOMAIN;
  check(!!key, "DAILY_API_KEY is set");
  check(!!domain, "NEXT_PUBLIC_DAILY_DOMAIN is set");
  if (!key || !domain) return;

  const me = await fetch(`${API}/`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  check(me.ok, `Daily REST authenticates (HTTP ${me.status})`);
  if (!me.ok) return;
  const body = await me.json();
  const expected = domain.replace(/^https?:\/\//, "").split(".")[0];
  check(
    body.domain_name === expected,
    `domain matches the key (${body.domain_name})`,
  );
  check(body.config?.account_suspended !== true, "account is not suspended");
  check(body.config?.block_api_requests !== true, "API requests are not blocked");

  info("");
  info("NOTE: none of the above proves anyone can JOIN. The REST plane and the");
  info("media plane fail independently — this account passed every REST check");
  info("while refusing every session with account-missing-payment-method.");
  info("Run `npm run webinar-e2e -- --provider=daily` to test the media plane.");
}

// ---------------------------------------------------------------------------
// Data every provider depends on
// ---------------------------------------------------------------------------
async function checkData() {
  console.log("\nscheduled webinars");
  const res = await rest(
    "events?select=id,title,starts_at,ends_at,live_mode,daily_room_name&live_mode=eq.hosted&order=starts_at.asc&limit=200",
  );
  if (!res.ok) {
    check(false, `could not read events (HTTP ${res.status})`);
    return;
  }
  const events = await res.json();
  pass(`${events.length} hosted webinar(s) scheduled`);

  const now = Date.now();
  const upcoming = events.filter((e: any) => +new Date(e.starts_at) > now);
  info(`${upcoming.length} still in the future`);

  if (PROVIDER === "builtin") {
    // The built-in provider has no provider-side room: the event id IS the
    // room. So a hosted event is joinable the moment it is scheduled, and the
    // stale-room class of bug simply does not exist here. Worth saying,
    // because these columns are still populated on older rows.
    const leftovers = events.filter((e: any) => e.daily_room_name).length;
    pass("no provider-side rooms to expire (the event id is the room)");
    if (leftovers > 0) {
      info(`${leftovers} row(s) still carry an old daily_room_name — harmless, ignored`);
    }
    return;
  }

  // Daily: every stored room must outlive its own webinar. This is the check
  // that catches the 0069 breakage, where moving every webinar to a Sunday
  // left 17 of 18 pointing at a room that expired before the webinar started.
  let dead = 0;
  let expiring = 0;
  for (const e of upcoming) {
    if (!e.daily_room_name) {
      warn(`no room: ${e.title.slice(0, 50)}`);
      continue;
    }
    const r = await fetch(`${API}/rooms/${encodeURIComponent(e.daily_room_name)}`, {
      headers: { Authorization: `Bearer ${process.env.DAILY_API_KEY}` },
    });
    if (r.status === 404) {
      dead++;
      console.log(`  FAIL  room already deleted: ${e.title.slice(0, 45)}`);
      failures++;
      continue;
    }
    const room = await r.json();
    const exp = room?.config?.exp;
    const end = e.ends_at ? +new Date(e.ends_at) : +new Date(e.starts_at) + 3600e3;
    if (exp && exp * 1000 <= end) {
      expiring++;
      console.log(
        `  FAIL  room expires before the webinar ends: ${e.title.slice(0, 40)}`,
      );
      failures++;
    }
  }
  if (dead === 0 && expiring === 0 && upcoming.length > 0) {
    pass("every upcoming webinar's room outlives it");
  }
}

/**
 * Everything migration 0084 added, and whether it is actually there.
 *
 * All of it is optional by design — the feature degrades to "a webinar without
 * decks, chat or speakers" rather than to "nobody can join" — which is exactly
 * why it needs a doctor. A missing table here is silent at runtime: the reads
 * in lib/webinar-data.ts swallow PGRST205 on purpose, so the only symptom of an
 * unapplied migration is panels that are mysteriously empty. This turns that
 * into a line of output.
 *
 * Read-only. Every call is a bare GET, so it is safe to run while a webinar is
 * in progress — though note it is still talking to whatever .env.local points
 * at, which is production.
 */
async function checkWebinars() {
  console.log("\nwebinars (migration 0084)");

  const tables: [string, string][] = [
    ["event_speakers", "guest speakers"],
    ["event_assets", "decks, premieres and recordings"],
    ["webinar_messages", "live chat"],
    ["webinar_question_votes", "question upvotes"],
    ["webinar_polls", "polls"],
  ];
  let missing = 0;
  for (const [table, what] of tables) {
    const r = await rest(`${table}?select=*&limit=1`);
    if (r.ok) {
      pass(`${table} present — ${what} work`);
    } else {
      missing++;
      warn(`${table} missing — ${what} silently unavailable`);
    }
  }
  if (missing > 0) {
    info("Apply supabase/migrations/0084_webinars.sql in the Supabase SQL editor.");
    info("Do it BEFORE deploying the code that reads these tables, not after.");
    // Deliberately a warning and not a failure: a deploy that is ahead of the
    // SQL is a real, recoverable state, and every webinar still runs in it.
    return;
  }

  // The new events columns. A 400 here means the column is absent, which is
  // the same "0084 not applied" condition reported more precisely.
  const cols = await rest(
    "events?select=id,audience_mode,auto_record,auto_share,premiere_seconds,assets_shared_at&limit=1",
  );
  check(cols.ok, "events carries the webinar columns");

  // The audience-mode census. This is the one number in this script worth
  // reading every time: `private` is the default and the safe answer, and a
  // webinar in `open` is one where students see each other's names. Nobody
  // should discover that from a student.
  const modes = await rest(
    "events?select=id,title,audience_mode,live_mode,starts_at&or=(type.eq.webinar,live_mode.eq.hosted,live_mode.eq.premiere)&limit=200",
  );
  if (modes.ok) {
    const rows = await modes.json();
    const open = rows.filter((e: any) => e.audience_mode === "open");
    const moderated = rows.filter((e: any) => e.audience_mode === "moderated");
    info(
      `${rows.length} webinar(s): ${rows.length - open.length - moderated.length} private, ` +
        `${moderated.length} moderated, ${open.length} open`,
    );
    for (const e of open) {
      warn(
        `open chat — students see each other by name: ${String(e.title).slice(0, 45)}`,
      );
    }

    // A premiere with no video is an event nobody can watch: the page falls
    // back to the live room and the audience waits for a host who was never
    // going to appear.
    const premieres = rows.filter((e: any) => e.live_mode === "premiere");
    for (const e of premieres) {
      const a = await rest(
        `event_assets?select=id&event_id=eq.${e.id}&kind=eq.premiere&limit=1`,
      );
      const has = a.ok && (await a.json()).length > 0;
      check(
        has,
        `premiere has a video to play: ${String(e.title).slice(0, 40)}`,
      );
    }
  }

  // The storage bucket the whole feature writes to.
  const bucket = await fetch(`${SUPABASE_URL}/storage/v1/bucket/webinar-media`, {
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` },
  });
  check(bucket.ok, "webinar-media bucket exists");
  if (bucket.ok) {
    const b = await bucket.json();
    check(b.public === false, "webinar-media is private (decks are not public)");
  }

  // auto_share is inert without the cron. Worth naming, because the symptom is
  // an admin ticking a box and nothing ever happening.
  if (!process.env.CRON_SECRET) {
    warn("CRON_SECRET unset — the auto-share follow-up job cannot run");
  } else {
    pass("CRON_SECRET set — /api/cron/webinar-followups can run");
  }
}

async function main() {
  console.log(`\nwebinar-doctor — active provider: ${PROVIDER}`);

  if (PROVIDER === "builtin") await checkBuiltin();
  else await checkDaily();

  await checkData();
  await checkWebinars();

  console.log("\nmedia plane");
  info("Configuration checks cannot prove a student sees the host.");
  info("Run `npm run dev` then `npm run webinar-e2e` for that — it drives two");
  info("real browsers into a real room and asserts on decoded frames.");

  console.log(
    failures === 0
      ? `\nNo failures${warnings ? ` (${warnings} warning(s))` : ""} — the webinar system is configured correctly.\n`
      : `\n${failures} check(s) FAILED — see above.\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("\nwebinar-doctor failed:\n", err instanceof Error ? err.stack : err);
  process.exit(1);
});
