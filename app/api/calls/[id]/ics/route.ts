import { requireUser, getProfile } from "@/lib/auth";
import { getInvite } from "@/lib/calls";
import { inviteEndsAt } from "@/lib/live";
import { env } from "@/lib/env";

/**
 * Calendar export for a 1:1 call.
 *
 * Modelled on /api/events/[id]/ics, with one difference that matters: this one
 * authenticates. An event is shared with a cohort; a 1:1 is between two named
 * people, so the endpoint answers only to those two rather than to anyone
 * holding the id.
 *
 * The URL in the invite points at batch0.org, never at the room. The room is
 * private and needs a minted token, so a calendar entry forwarded to a
 * colleague grants nothing.
 */

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

export async function GET(_req: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  await requireUser();
  const profile = await getProfile();
  if (!profile) return new Response("Not found", { status: 404 });

  const invite = await getInvite(params.id);
  if (
    !invite ||
    (invite.hostId !== profile.id && invite.inviteeId !== profile.id)
  ) {
    // 404 rather than 403 — a stranger should not learn that this id exists.
    return new Response("Not found", { status: 404 });
  }

  const other =
    invite.hostId === profile.id ? invite.inviteeName : invite.hostName;
  const summary = invite.topic
    ? `${invite.topic} — 1:1 with ${other}`
    : `1:1 with ${other}`;
  const joinUrl = `${env.siteUrl}/dashboard/calls/${invite.id}/live`;

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//batch0//Calls//EN",
    "BEGIN:VEVENT",
    `UID:call-${invite.id}@batch0.org`,
    `DTSTAMP:${toIcsDate(new Date().toISOString())}`,
    `DTSTART:${toIcsDate(invite.startsAt)}`,
    `DTEND:${toIcsDate(inviteEndsAt(invite))}`,
    `SUMMARY:${escapeIcs(summary)}`,
    `DESCRIPTION:${escapeIcs(`Join at ${joinUrl}`)}`,
    `URL:${escapeIcs(joinUrl)}`,
    // A cancelled or declined call should grey out in the calendar rather
    // than sitting there looking live.
    `STATUS:${invite.status === "accepted" ? "CONFIRMED" : "CANCELLED"}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ];

  // RFC 5545 requires the trailing CRLF; Outlook Web drops the event without it.
  return new Response(lines.join("\r\n") + "\r\n", {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `attachment; filename="call-${invite.id}.ics"`,
      // Per-user and auth-gated — never let a shared cache hold this.
      "Cache-Control": "private, no-store",
    },
  });
}
