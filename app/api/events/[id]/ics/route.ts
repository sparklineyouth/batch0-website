import { createClient } from "@/lib/supabase/server";
import { env } from "@/lib/env";

function pad(n: number) {
  return String(n).padStart(2, "0");
}

function toIcsDate(iso: string) {
  const d = new Date(iso);
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
}

function escapeIcs(s: string) {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;")
    .replace(/\r\n/g, "\\n")
    .replace(/\r/g, "\\n")
    .replace(/\n/g, "\\n");
}

export async function GET(_req: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const supabase = await createClient();
  const { data: event } = await supabase
    .from("events")
    .select("*")
    .eq("id", params.id)
    .maybeSingle();
  if (!event) {
    return new Response("Not found", { status: 404 });
  }

  const ev = event as any;
  // A hosted event's calendar entry points at batch0.org, not at the room.
  // The room is private and needs a minted token, so the raw URL in someone's
  // calendar would fail to open — and the page it points at instead is the
  // one that decides whether they're allowed in.
  const joinUrl =
    ev.live_mode === "hosted"
      ? `${env.siteUrl}/dashboard/events/${ev.id}/live`
      : ev.zoom_url;
  const start = toIcsDate(ev.starts_at);
  const end = toIcsDate(
    ev.ends_at ?? new Date(new Date(ev.starts_at).getTime() + 60 * 60 * 1000).toISOString(),
  );

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//batch0//Events//EN",
    "BEGIN:VEVENT",
    `UID:${ev.id}@batch0.org`,
    `DTSTAMP:${toIcsDate(new Date().toISOString())}`,
    `DTSTART:${start}`,
    `DTEND:${end}`,
    `SUMMARY:${escapeIcs(ev.title)}`,
    ev.description ? `DESCRIPTION:${escapeIcs(ev.description)}` : "",
    ev.location ? `LOCATION:${escapeIcs(ev.location)}` : "",
    joinUrl ? `URL:${escapeIcs(joinUrl)}` : "",
    "END:VEVENT",
    "END:VCALENDAR",
  ].filter(Boolean);

  // RFC 5545 requires a trailing CRLF after END:VCALENDAR. Several
  // stricter parsers (notably Outlook Web) drop the event silently
  // without it.
  return new Response(lines.join("\r\n") + "\r\n", {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `attachment; filename="${ev.id}.ics"`,
    },
  });
}
