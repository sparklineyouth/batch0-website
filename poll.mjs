import { createClient } from "@supabase/supabase-js";
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const ID = "b42e540b-6e63-4cf2-893f-862c9bd424fd";
const deadline = Date.now() + 45 * 60 * 1000;
while (Date.now() < deadline) {
  const { data } = await db.from("email_outbox").select("status, attempts, provider_id, last_error, sent_at").eq("id", ID).single();
  const stamp = new Date().toISOString().slice(11, 16);
  if (data.status !== "pending") {
    console.log(`${stamp}Z  RESOLVED status=${data.status} attempts=${data.attempts} provider_id=${data.provider_id ?? "-"} error=${data.last_error ?? "-"} sent_at=${data.sent_at ?? "-"}`);
    process.exit(data.status === "sent" ? 0 : 1);
  }
  console.log(`${stamp}Z  still pending…`);
  await new Promise((r) => setTimeout(r, 120000));
}
console.log("TIMED OUT — the cron did not drain within 45 minutes");
process.exit(2);
