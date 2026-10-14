/**
 * Webinar doctor: is the live-video system actually able to run a webinar?
 *
 *   npm run webinar-doctor
 *
 * Checks batch0 Live and the data every webinar depends on.
 *
 * WHAT THIS CANNOT DO, AND WHY IT SAYS SO
 * ---------------------------------------
 * No amount of configuration checking proves a webinar works: a REST-plane
 * check once passed for months while every join failed on the media plane.
 *
 * So this script ends by telling you to run `npm run webinar-e2e`, which
 * drives two real browsers into a real room and asserts on decoded frames.
 * That is the only check that can say "a student sees the host".
 */

import { createClient } from "@supabase/supabase-js";

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
// Scheduled webinars
// ---------------------------------------------------------------------------
async function checkData() {
  console.log("\nscheduled webinars");
  const res = await rest(
    "events?select=id,title,starts_at&live_mode=in.(hosted,premiere)&order=starts_at.asc&limit=200",
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

  // The event id is the room: a hosted event is joinable the moment it is
  // scheduled, with nothing provider-side to expire.
  pass("no provider-side rooms to expire (the event id is the room)");
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
    ["event_assets", "decks and older recordings"],
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

  // Chat settings at a glance. `open` (chat on, hosts remove messages) is the
  // default for new events since 0098; `private` is chat off. Counts only:
  // every mode is a valid choice.
  const modes = await rest(
    "events?select=id,audience_mode&or=(type.eq.webinar,live_mode.eq.hosted,live_mode.eq.premiere)&limit=1000",
  );
  if (modes.ok) {
    const rows = await modes.json();
    const count = (m: string) => rows.filter((e: any) => e.audience_mode === m).length;
    info(
      `${rows.length} webinar(s): ${count("open")} chat open, ` +
        `${count("moderated")} moderated, ${count("private")} chat off`,
    );
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
  console.log("\nwebinar-doctor");

  await checkBuiltin();

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
