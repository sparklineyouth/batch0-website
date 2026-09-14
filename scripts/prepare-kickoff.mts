/** Prepare the actual cohort room. Preview by default; --apply publishes it.
 * No email, billing, enrollment, or permission changes are performed. */
import { createClient } from "@supabase/supabase-js";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const COHORT = "6350c6ac-70f0-4f53-93d5-c99e397185a9";
const EVENT = "1bbfd694-24be-4c83-a450-ff85c06716a0";
const START = "2026-09-15T00:00:00.000Z";
const END = "2026-09-15T01:00:00.000Z";
const EXPIRES = "2026-09-15T03:00:00.000Z";
const ROOM = "cohort1-kickoff-20260914";
const apply = process.argv.includes("--apply");
const s = createClient(required("NEXT_PUBLIC_SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"));
function required(k: string) { const v = process.env[k]; if (!v) throw new Error(`Missing ${k}`); return v; }
async function daily(path: string, body?: object) {
  const r = await fetch(`https://api.daily.co/v1${path}`, {
    method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${required("DAILY_API_KEY")}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 404 && !body) return null;
  if (!r.ok) throw new Error(`Daily ${r.status}: room setup failed; no credentials printed.`);
  return r.json();
}
const { data: cohort, error: ce } = await s.from("cohorts").select("id,name,starts_on,status").eq("id", COHORT).single();
if (ce || cohort.starts_on !== "2026-09-14" || cohort.status === "cancelled") throw new Error("Cohort does not match the reviewed kickoff plan.");
const { data: existing, error: ee } = await s.from("events").select("*").eq("id", EVENT).maybeSingle();
if (ee) throw new Error("Cannot inspect existing event.");
const event = {
  id: EVENT, cohort_id: COHORT, type: "workshop",
  title: "Cohort 1 kickoff — find a problem worth solving",
  description: "Monday, September 14, 8:00–9:00 p.m. U.S. Eastern (EDT). Join opens at 7:45 p.m. Sign in with the email you used to enroll. Bring a notebook and one problem you have noticed. We will meet the cohort, tour the course, choose a customer problem, and plan the first evidence-gathering sprint. No polished idea or prior startup experience required. Use the private Q&A panel for questions. Course notes and the Week 1 workbook are available in Course. For access help, email hello@batch0.org.",
  starts_at: START, ends_at: END, location: "Live on batch0.org", zoom_url: null,
  visibility: "enrolled", live_mode: "hosted", daily_room_name: ROOM,
};
if (existing && (existing.cohort_id !== COHORT || existing.daily_room_name !== ROOM)) throw new Error("Event ID is occupied by a different event; refusing overwrite.");
console.log(JSON.stringify({ mode: apply ? "apply" : "preview", cohort: cohort.name, event, join_url: `https://batch0.org/dashboard/events/${EVENT}/live`, join_opens: "2026-09-14T23:45:00.000Z", cost: "No paid recording or large-call features requested", sends_email: false }, null, 2));
if (apply) {
  if (Date.now() >= Date.parse(END)) throw new Error("Kickoff has ended; refusing to publish a past launch.");
  const dir = resolve("out/kickoff-20260914");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(`${dir}/event-before-${Date.now()}.json`, JSON.stringify(existing, null, 2), { mode: 0o600 });
  let room = await daily(`/rooms/${ROOM}`);
  if (room) {
    if (room.privacy !== "private" || !room.config?.owner_only_broadcast || room.config.exp * 1000 < Date.parse(END)) throw new Error("Existing room does not meet privacy/expiry requirements.");
  } else {
    room = await daily("/rooms", { name: ROOM, privacy: "private", properties: {
      exp: Date.parse(EXPIRES) / 1000, eject_at_room_exp: true,
      owner_only_broadcast: true, enable_screenshare: true, enable_chat: false, enable_prejoin_ui: false,
    } });
  }
  const payload = { ...event, daily_room_url: room.url };
  const saved = await s.from("events").upsert(payload, { onConflict: "id" }).select("id,title,starts_at,ends_at,visibility,live_mode").single();
  if (saved.error) throw new Error(`Event save failed (${saved.error.code}); room has automatic expiry.`);
  const audit = await s.from("audit_log").insert({ action: "kickoff.prepared", target_type: "event", target_id: EVENT, payload: { source: "authorized Batch0 launch preparation", starts_at: START, paid_features: false, sends_email: false } });
  if (audit.error) throw new Error("Event saved, but audit failed; inspect before retrying.");
  console.log(JSON.stringify({ verified_event: saved.data, room_private: room.privacy === "private" }));
}
