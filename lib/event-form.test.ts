import test from "node:test";
import assert from "node:assert/strict";
import {
  adminGroup,
  audienceFor,
  durationOf,
  durationOptions,
  earlyStartSchedule,
  endsAtFor,
  eventNoticeLink,
  floorToMinute,
  fromLocalInput,
  goLiveNowAudience,
  liveForAudience,
  nextRoundHour,
  parseHttpUrl,
  parseWho,
  pickDefaultCohort,
  roomActionLabel,
  staleRunStamps,
  studentEventStatus,
  toLocalInput,
  validateEventFields,
  whoFromRow,
  whoValue,
} from "./event-form.ts";
import { roomAccess, roomIsOpen, shouldStampLiveStart } from "./live.ts";

const COHORT = "6350c6ac-70f0-4f53-93d5-c99e397185a9";
const OTHER = "76bc78bc-1724-48d3-9215-9049045b279a";

// ---- time ------------------------------------------------------------------

test("nextRoundHour is the next whole hour, today", () => {
  const d = nextRoundHour(new Date(2026, 9, 14, 14, 20, 31));
  assert.deepEqual(
    [d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()],
    [2026, 9, 14, 15, 0, 0],
  );
  // On the hour still moves to the next one: never a start in the past.
  assert.equal(nextRoundHour(new Date(2026, 9, 14, 14, 0, 0)).getHours(), 15);
  // Any weekday — no Sunday rule.
  assert.equal(nextRoundHour(new Date(2026, 9, 12, 9, 5)).getDay(), 1);
});

test("nextRoundHour rolls over midnight", () => {
  const d = nextRoundHour(new Date(2026, 9, 14, 23, 30));
  assert.equal(d.getDate(), 15);
  assert.equal(d.getHours(), 0);
});

test("datetime-local round-trips and rejects empty or junk input", () => {
  const iso = new Date(2026, 9, 14, 20, 0).toISOString();
  assert.equal(fromLocalInput(toLocalInput(iso)), iso);
  assert.equal(toLocalInput(null), "");
  assert.equal(toLocalInput("nope"), "");
  // The old form crashed on '' (new Date('').toISOString() throws).
  assert.equal(fromLocalInput(""), null);
  assert.equal(fromLocalInput("   "), null);
  assert.equal(fromLocalInput("2026-13-45T99:99"), null);
});

test("floorToMinute drops seconds", () => {
  const d = floorToMinute(new Date("2026-10-14T20:07:42.123Z"));
  assert.equal(d.toISOString(), "2026-10-14T20:07:00.000Z");
});

test("duration → ends_at, and back", () => {
  const start = "2026-10-14T00:00:00.000Z";
  assert.equal(endsAtFor(start, 60), "2026-10-14T01:00:00.000Z");
  assert.equal(endsAtFor(start, 45), "2026-10-14T00:45:00.000Z");
  assert.equal(durationOf(start, "2026-10-14T01:30:00.000Z"), 90);
  // No end, or a broken one (end before start), reads as the default hour.
  assert.equal(durationOf(start, null), 60);
  assert.equal(durationOf(start, "2026-10-13T23:00:00.000Z"), 60);
});

test("durationOptions keeps an old row's custom length", () => {
  assert.deepEqual(durationOptions(60), [30, 45, 60, 90, 120]);
  assert.deepEqual(durationOptions(75), [30, 45, 60, 75, 90, 120]);
});

// ---- links -----------------------------------------------------------------

test("parseHttpUrl accepts http(s) only", () => {
  assert.deepEqual(parseHttpUrl(""), { ok: true, url: null });
  assert.deepEqual(parseHttpUrl("  "), { ok: true, url: null });
  assert.deepEqual(parseHttpUrl(null), { ok: true, url: null });
  assert.deepEqual(parseHttpUrl(" https://zoom.us/j/123 "), {
    ok: true,
    url: "https://zoom.us/j/123",
  });
  assert.equal(parseHttpUrl("http://example.com").ok, true);
  for (const bad of [
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "data:text/html,hi",
    "mailto:a@b.c",
    "zoom.us/j/123",
    "ftp://example.com/x",
    "https://",
  ]) {
    assert.equal(parseHttpUrl(bad).ok, false, bad);
  }
});

// ---- who -------------------------------------------------------------------

test("parseWho / whoValue round-trip and reject junk", () => {
  for (const v of [`cohort:${COHORT}`, "public", "staff"]) {
    assert.equal(whoValue(parseWho(v)!), v);
  }
  assert.equal(parseWho("cohort:"), null);
  assert.equal(parseWho("cohort:not-a-uuid"), null);
  assert.equal(parseWho("enrolled"), null);
  assert.equal(parseWho(undefined), null);
});

test("enrolled always carries a cohort", () => {
  assert.deepEqual(audienceFor({ kind: "cohort", cohortId: COHORT }, null), {
    visibility: "enrolled",
    cohort_id: COHORT,
  });
  // Public/staff keep the cohort an existing row had, and new ones get none.
  assert.deepEqual(audienceFor({ kind: "public" }, OTHER), {
    visibility: "public",
    cohort_id: OTHER,
  });
  assert.deepEqual(audienceFor({ kind: "staff" }, null), {
    visibility: "staff",
    cohort_id: null,
  });
});

test("a legacy cohort-less enrolled row opens on the fallback cohort", () => {
  assert.equal(
    whoFromRow({ visibility: "enrolled", cohort_id: null }, COHORT),
    `cohort:${COHORT}`,
  );
  assert.equal(whoFromRow({ visibility: "enrolled", cohort_id: OTHER }, COHORT), `cohort:${OTHER}`);
  assert.equal(whoFromRow({ visibility: "public", cohort_id: OTHER }, COHORT), "public");
  assert.equal(whoFromRow({ visibility: "staff", cohort_id: null }, COHORT), "staff");
  assert.equal(whoFromRow({ visibility: "enrolled", cohort_id: null }, null), "public");
});

test("pickDefaultCohort: running, else next, else most recent", () => {
  const now = new Date("2026-10-14T12:00:00Z");
  const summer = { id: "summer", startsOn: "2026-06-15", endsOn: "2026-07-13", status: "completed" };
  const fall = { id: "fall", startsOn: "2026-09-14", endsOn: "2026-11-13", status: "upcoming" };
  const winter = { id: "winter", startsOn: "2027-01-10", endsOn: "2027-03-01", status: "upcoming" };
  const spring = { id: "spring", startsOn: "2027-03-20", endsOn: "2027-05-01", status: "upcoming" };
  assert.equal(pickDefaultCohort([summer, fall, winter], now), "fall");
  assert.equal(pickDefaultCohort([summer, spring, winter], now), "winter");
  assert.equal(pickDefaultCohort([summer], now), "summer");
  assert.equal(pickDefaultCohort([], now), null);
  // An explicit 'active' wins even without dates.
  assert.equal(
    pickDefaultCohort([winter, { id: "x", startsOn: null, endsOn: null, status: "active" }], now),
    "x",
  );
  // Cancelled cohorts are never the default.
  assert.equal(
    pickDefaultCohort([{ ...fall, status: "cancelled" }, winter], now),
    "winter",
  );
});

// ---- validation ------------------------------------------------------------

const valid = {
  title: "Pitch practice",
  startsAt: "2026-10-14T20:00:00.000Z",
  durationMinutes: 60,
  liveMode: "hosted" as const,
  externalUrl: "",
  recordingUrl: "",
  who: `cohort:${COHORT}`,
};

test("only a title and a time are needed", () => {
  assert.deepEqual(validateEventFields(valid), {});
});

test("validation names every broken field", () => {
  assert.equal(validateEventFields({ ...valid, title: "   " }).title, "Add a title.");
  assert.ok(validateEventFields({ ...valid, title: "x".repeat(201) }).title);
  assert.ok(validateEventFields({ ...valid, startsAt: null }).startsAt);
  assert.ok(validateEventFields({ ...valid, startsAt: "garbage" }).startsAt);
  assert.ok(validateEventFields({ ...valid, durationMinutes: 0 }).duration);
  assert.ok(validateEventFields({ ...valid, durationMinutes: 2.5 }).duration);
  assert.ok(validateEventFields({ ...valid, durationMinutes: 24 * 60 }).duration);
  assert.ok(validateEventFields({ ...valid, who: "enrolled" }).who);
  assert.ok(
    validateEventFields({ ...valid, liveMode: "external", externalUrl: "javascript:x" })
      .externalUrl,
  );
  assert.ok(validateEventFields({ ...valid, recordingUrl: "ftp://x.y/z" }).recordingUrl);
  assert.ok(validateEventFields({ ...valid, durationMinutes: -60 }).duration);
  // An external event with no link is fine (in person); a hosted one ignores it.
  assert.deepEqual(validateEventFields({ ...valid, liveMode: "external" }), {});
  assert.deepEqual(validateEventFields({ ...valid, externalUrl: "junk" }), {});
});

test("an edited event keeps a saved length outside the bounds", () => {
  // A two-day Demo Day: 09:00 Nov 1 to 18:00 Nov 2.
  const saved = durationOf("2026-11-01T09:00:00Z", "2026-11-02T18:00:00Z");
  assert.equal(saved, 1980);
  assert.ok(validateEventFields({ ...valid, durationMinutes: saved }).duration);
  assert.deepEqual(
    validateEventFields({ ...valid, durationMinutes: saved, savedDurationMinutes: saved }),
    {},
  );
  // Changing it still has to land on a sane length.
  assert.ok(
    validateEventFields({ ...valid, durationMinutes: 3000, savedDurationMinutes: saved }).duration,
  );
  assert.deepEqual(
    validateEventFields({ ...valid, durationMinutes: 90, savedDurationMinutes: saved }),
    {},
  );
});

// ---- admin list ------------------------------------------------------------

const at = (base: Date, minutes: number) =>
  new Date(base.getTime() + minutes * 60_000).toISOString();

test("adminGroup: live, upcoming, past", () => {
  const now = new Date("2026-10-14T20:00:00Z");
  const ev = (startMin: number, extra: Partial<Parameters<typeof adminGroup>[0]> = {}) => ({
    startsAt: at(now, startMin),
    endsAt: at(now, startMin + 60),
    liveStartedAt: null,
    liveEndedAt: null,
    ...extra,
  });
  assert.equal(adminGroup(ev(-10), now, false), "live");
  assert.equal(adminGroup(ev(10), now, false), "upcoming");
  assert.equal(adminGroup(ev(24 * 60), now, false), "upcoming");
  // A host on air early is live; a host who went live early too.
  assert.equal(adminGroup(ev(120), now, true), "live");
  assert.equal(adminGroup(ev(120, { liveStartedAt: at(now, -1) }), now, false), "live");
  // Ended is past whatever the clock says.
  assert.equal(adminGroup(ev(-10, { liveEndedAt: at(now, -1) }), now, true), "past");
  // Over: past end+30m with nobody on air…
  assert.equal(adminGroup(ev(-120), now, false), "past");
  // …unless someone is still hosting, up to the hard close (end + 3h).
  assert.equal(adminGroup(ev(-120), now, true), "live");
  assert.equal(adminGroup(ev(-300), now, true), "past");
});

test("roomActionLabel follows who is hosting", () => {
  const now = new Date("2026-10-14T20:00:00Z");
  const e = (startMin: number) => ({
    startsAt: at(now, startMin),
    endsAt: at(now, startMin + 60),
    liveStartedAt: null,
    liveEndedAt: null,
  });
  assert.equal(roomActionLabel("live", true, e(-5), now), "Join");
  assert.equal(roomActionLabel("live", false, e(-5), now), "Start");
  // Inside the 15-minute lead-in: Start. Within the host window: Open room.
  assert.equal(roomActionLabel("upcoming", false, e(10), now), "Start");
  assert.equal(roomActionLabel("upcoming", false, e(30), now), "Open room");
  assert.equal(roomActionLabel("past", false, e(-300), now), null);
  // Further out, the button follows lib/live.ts's host window: no button
  // while hosts would only get a "not open yet" page.
  for (const mins of [120, 7 * 24 * 60]) {
    const hostsIn = roomIsOpen(
      roomAccess({
        startsAt: e(mins).startsAt,
        endsAt: e(mins).endsAt,
        liveEndedAt: null,
        isHost: true,
        hostPresent: false,
        now,
      }),
    );
    assert.equal(roomActionLabel("upcoming", false, e(mins), now), hostsIn ? "Open room" : null);
  }
});

test("staleRunStamps clears a previous run's stamps on reschedule", () => {
  const start = "2026-10-20T20:00:00.000Z";
  const prior = {
    live_started_at: "2026-10-13T20:01:00.000Z",
    live_ended_at: "2026-10-13T21:00:00.000Z",
    assets_shared_at: null,
  };
  assert.deepEqual(staleRunStamps(prior, start), { live_started_at: null, live_ended_at: null });
  // A host who went live half an hour early is this run: kept.
  assert.deepEqual(
    staleRunStamps({ live_started_at: "2026-10-20T19:30:00.000Z" }, start),
    {},
  );
  assert.deepEqual(staleRunStamps({}, start), {});
});

test("going live hours early moves the run to now, keeping its length", () => {
  const now = new Date("2026-10-20T14:07:30.000Z");
  const moved = earlyStartSchedule("2026-10-20T17:00:00.000Z", "2026-10-20T18:30:00.000Z", now);
  assert.deepEqual(moved, { startsAt: "2026-10-20T14:07:00.000Z", endsAt: "2026-10-20T15:37:00.000Z" });
  // The stamp written with it belongs to the new run: stampable, never stale.
  assert.equal(
    shouldStampLiveStart({ startsAt: moved!.startsAt, endsAt: moved!.endsAt, liveStartedAt: null, liveEndedAt: null, now }),
    true,
  );
  assert.deepEqual(staleRunStamps({ live_started_at: now.toISOString() }, moved!.startsAt), {});
  // No end: the default length.
  const open = earlyStartSchedule("2026-10-20T17:00:00.000Z", null, now)!;
  assert.equal(Date.parse(open.endsAt) - Date.parse(open.startsAt), 60 * 60_000);
  // Inside the go-live window the schedule stands: a host's arrival stamps it.
  assert.equal(earlyStartSchedule("2026-10-20T15:00:00.000Z", null, now), null);
  assert.equal(earlyStartSchedule("2026-10-20T13:00:00.000Z", null, now), null);
});

test("Go live now's confirm names who is told, as announceLive picks them", () => {
  assert.equal(
    goLiveNowAudience({ visibility: "enrolled", cohortId: COHORT, cohortName: " Winter 2027 " }),
    "Everyone in Winter 2027 gets a notification and an email.",
  );
  // "Everyone signed in" that kept its cohort: that cohort is told.
  assert.equal(
    goLiveNowAudience({ visibility: "public", cohortId: COHORT, cohortName: null }),
    "Everyone in its cohort gets a notification and an email.",
  );
  assert.equal(
    goLiveNowAudience({ visibility: "public", cohortId: null }),
    "Students in every upcoming and active cohort get a notification and an email.",
  );
  assert.equal(
    goLiveNowAudience({ visibility: "staff", cohortId: COHORT, cohortName: "Winter 2027" }),
    "It's staff-only, so nobody is notified.",
  );
  assert.equal(goLiveNowAudience({ visibility: "enrolled", cohortId: null }), "Nobody is notified: it has no cohort.");
});

test("studentEventStatus opens early when a host goes live", () => {
  const now = new Date("2026-10-14T20:00:00Z");
  const base = {
    startsAt: at(now, 120),
    endsAt: at(now, 180),
    liveStartedAt: null as string | null,
    liveEndedAt: null as string | null,
  };
  assert.equal(studentEventStatus(base, now), "upcoming");
  assert.equal(studentEventStatus({ ...base, liveStartedAt: at(now, -2) }, now), "live");
  assert.equal(
    studentEventStatus({ ...base, liveStartedAt: at(now, -2), liveEndedAt: at(now, -1) }, now),
    "ended",
  );
  // A stale live stamp past the hard close does not keep it live.
  const old = { ...base, startsAt: at(now, -600), endsAt: at(now, -540), liveStartedAt: at(now, -600) };
  assert.equal(studentEventStatus(old, now), "past");
});

// ---- notices -----------------------------------------------------------------

test("eventNoticeLink: pre-cohort students only hear about hosted rooms", () => {
  const hosted = { id: "e1", hosted: true };
  const external = { id: "e2", hosted: false };
  // Started cohort: the events list for a new event, the room once live.
  assert.equal(eventNoticeLink(hosted, "posted", false), "/dashboard/events");
  assert.equal(eventNoticeLink(hosted, "live", false), "/dashboard/events/e1/live");
  assert.equal(eventNoticeLink(external, "posted", false), "/dashboard/events");
  // Pre-cohort: /dashboard/events bounces them home, the room does not.
  assert.equal(eventNoticeLink(hosted, "posted", true), "/dashboard/events/e1/live");
  assert.equal(eventNoticeLink(hosted, "live", true), "/dashboard/events/e1/live");
  assert.equal(eventNoticeLink(external, "posted", true), null);
  assert.equal(eventNoticeLink(external, "live", true), null);
});

test("liveForAudience finds a running webinar for the same people", () => {
  const now = new Date("2026-10-14T20:00:00Z");
  const row = (over: Partial<Parameters<typeof liveForAudience>[0][number]> = {}) => ({
    id: "w1",
    title: "Live session",
    visibility: "enrolled",
    cohortId: COHORT,
    liveMode: "hosted",
    startsAt: at(now, -10),
    endsAt: at(now, 50),
    liveStartedAt: at(now, -10),
    liveEndedAt: null as string | null,
    ...over,
  });
  const cohort = { visibility: "enrolled" as const, cohort_id: COHORT };
  assert.equal(liveForAudience([row()], cohort, now)?.id, "w1");
  // Running on schedule with nobody on yet counts too.
  assert.equal(liveForAudience([row({ liveStartedAt: null })], cohort, now)?.id, "w1");
  // Another cohort, ended, later today, external: not a duplicate.
  assert.equal(liveForAudience([row({ cohortId: OTHER })], cohort, now), null);
  assert.equal(liveForAudience([row({ liveEndedAt: at(now, -1) })], cohort, now), null);
  assert.equal(
    liveForAudience([row({ startsAt: at(now, 120), endsAt: at(now, 180), liveStartedAt: null })], cohort, now),
    null,
  );
  assert.equal(liveForAudience([row({ liveMode: "external" })], cohort, now), null);
  // Legacy premiere rows run as hosted rooms.
  assert.equal(liveForAudience([row({ liveMode: "premiere" })], cohort, now)?.id, "w1");
  // "Everyone" matches "everyone" whatever cohort the row kept.
  assert.equal(
    liveForAudience([row({ visibility: "public" })], { visibility: "public", cohort_id: null }, now)?.id,
    "w1",
  );
  // Past the hard close a forgotten stamp is not live.
  assert.equal(
    liveForAudience(
      [row({ startsAt: at(now, -600), endsAt: at(now, -540), liveStartedAt: at(now, -600) })],
      cohort,
      now,
    ),
    null,
  );
});
