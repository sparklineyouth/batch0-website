import { env } from "@/lib/env";
import { getChallengeBySlug } from "@/lib/challenges";

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
    .replace(/\r\n|\r|\n/g, "\\n");
}

/**
 * "Add to calendar" for a challenge. The entry that matters is the DEADLINE,
 * so that's what this is: a 30-minute block ending at closes_at, with a
 * reminder a day before. A multi-day block from opens_at would sit in the
 * all-day strip where nobody looks.
 */
export async function GET(_req: Request, props: { params: Promise<{ slug: string }> }) {
  const { slug } = await props.params;
  const c = await getChallengeBySlug(slug);
  if (!c || c.status === "draft" || !(c.closesAt || c.opensAt)) {
    return new Response("Not found", { status: 404 });
  }
  const url = `${env.siteUrl}/challenges/${c.slug}`;
  const end = c.closesAt ?? c.opensAt!;
  const start = new Date(new Date(end).getTime() - 30 * 60_000).toISOString();
  const summary = c.closesAt ? `Submissions due: ${c.title}` : c.title;

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//batch0//Challenges//EN",
    "BEGIN:VEVENT",
    `UID:challenge-${c.id}@batch0.org`,
    `DTSTAMP:${toIcsDate(new Date().toISOString())}`,
    `DTSTART:${toIcsDate(start)}`,
    `DTEND:${toIcsDate(end)}`,
    `SUMMARY:${escapeIcs(summary)}`,
    `DESCRIPTION:${escapeIcs(`${c.tagline ? c.tagline + "\n\n" : ""}Submit here: ${url}/submit`)}`,
    `LOCATION:${escapeIcs(c.location || "Online")}`,
    `URL:${escapeIcs(url)}`,
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    `DESCRIPTION:${escapeIcs(`${c.title} closes tomorrow`)}`,
    "TRIGGER:-P1D",
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
  ];

  // RFC 5545 wants a trailing CRLF; Outlook Web silently drops the event
  // without one.
  return new Response(lines.join("\r\n") + "\r\n", {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `attachment; filename="${c.slug}.ics"`,
    },
  });
}
