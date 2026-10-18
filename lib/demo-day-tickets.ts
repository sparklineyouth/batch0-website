// ---------------------------------------------------------------------------
// Demo Day tickets — the server side of "send someone a paid link for Demo
// Day only". The table is `demo_day_tickets` (migration 0070); the pure input
// helpers live in lib/demo-day-ticket-input.ts so the form and the tests can
// import them without pulling in Supabase.
//
// Three callers share this module:
//   app/admin/demo-day/tickets/actions.ts   — send / resend / cancel / refund
//   app/demo-day/ticket/[token]             — the public pay page
//   lib/stripe-fulfillment                  — what "paid" unlocks
// ---------------------------------------------------------------------------

import { randomBytes } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { env } from "@/lib/env";
import { sendTemplated } from "@/lib/email/dispatch";
import { Templates } from "@/lib/email/templates";
import { getSiteConfig } from "@/lib/site-config";
import { fmtDateOnly } from "@/lib/pre-cohort";
import { formatTicketAmount } from "@/lib/demo-day-ticket-input";
import { exactEmailLookup } from "@/lib/team-invites";
import { isHostedOnBatch0 } from "@/lib/webinars";
import { httpsUrl } from "@/lib/event-form";
import type { DemoDayTicket } from "@/lib/types";

/** Template keys, so the seed, the send and the admin editor agree. */
export const TICKET_INVITE_TEMPLATE = "demo_day.ticket_invite";
export const TICKET_CONFIRMED_TEMPLATE = "demo_day.ticket_confirmed";

/**
 * The secret in the pay link. 24 random bytes -> 32 URL-safe characters,
 * ~190 bits: unguessable, and short enough to survive being pasted into a
 * text message. The `unique` index makes a collision a loud insert error
 * rather than a silent overwrite.
 */
export function mintTicketToken(): string {
  return randomBytes(24).toString("base64url");
}

/** Shape of a token as it arrives in a URL — refuse anything else early. */
export function isTicketToken(raw: string): boolean {
  return /^[A-Za-z0-9_-]{32}$/.test(raw);
}

/**
 * The one place the pay link is built. The invite email, the admin's
 * "copy link" and the Stripe return URLs all come through here, so they can't
 * drift from each other or from the route at app/demo-day/ticket/[token].
 */
export function ticketPayUrl(token: string): string {
  return `${env.siteUrl}/demo-day/ticket/${encodeURIComponent(token)}`;
}

export async function getTicketByToken(
  token: string,
): Promise<DemoDayTicket | null> {
  if (!isTicketToken(token)) return null;
  const admin = createAdminClient();
  const { data } = await admin
    .from("demo_day_tickets")
    .select("*")
    .eq("token", token)
    .maybeSingle();
  return (data as DemoDayTicket | null) ?? null;
}

/**
 * The batch0 account behind an email, if there is exactly one. Matched
 * literally and case-insensitively (exactEmailLookup, lib/team-invites.ts).
 *
 * The address is whatever an admin or a scholarship holder typed for a
 * guest, and it used to go to ilike as it was: `%`, `_` and `*` are wildcards
 * there and legal in an address, so `%@gmail.com` or `a_c@school.edu` linked
 * the ticket to the first account the pattern hit — and that stranger then
 * saw Demo Day on their dashboard (the events policy, 0070). Two accounts
 * differing only by case link neither: the ticket still works from its pay
 * link, and guessing between them is how the wrong person gets it.
 */
export async function findProfileByEmail(
  email: string,
): Promise<{ id: string; full_name: string | null } | null> {
  const lookup = exactEmailLookup(email);
  if (!lookup.value.includes("@")) return null;
  const admin = createAdminClient();
  const base = admin.from("profiles").select("id, full_name");
  const { data } = await (lookup.op === "eq"
    ? base.eq("email", lookup.value)
    : base.ilike("email", lookup.value)
  ).limit(2);
  return data && data.length === 1 ? (data[0] as { id: string; full_name: string | null }) : null;
}

/**
 * What the ticket is FOR, as a human would say it: when Demo Day is and, if
 * the admin has set the event up, where.
 *
 * The events table is the source of truth when it has a `demo_day` row for
 * the cohort — that's what the dashboard shows a signed-in holder, so the
 * email must agree with it. Before the event exists, the admin-set
 * `demo_day_date` from site settings stands in, and before THAT there's just
 * "Demo Day". Every field is optional; the templates render around gaps.
 */
export type DemoDayDetails = {
  cohortName: string | null;
  /** "Saturday, November 14, 2026 at 1:00 PM ET", or just the date. */
  when: string | null;
  location: string | null;
  /** The Zoom/YouTube/etc. link for an external event. */
  externalUrl: string | null;
  /** True when the event is hosted on batch0 (joined from the dashboard). */
  hosted: boolean;
  eventId: string | null;
};

export async function getDemoDayDetails(
  cohortId: string | null,
): Promise<DemoDayDetails> {
  const admin = createAdminClient();

  let eventQuery = admin
    .from("events")
    .select(
      "id, title, starts_at, location, zoom_url, live_mode, cohort_id, cohort:cohorts(name)",
    )
    .eq("type", "demo_day")
    .order("starts_at", { ascending: false })
    .limit(1);
  if (cohortId) eventQuery = eventQuery.eq("cohort_id", cohortId);

  const [{ data: events }, cohortRow, config] = await Promise.all([
    eventQuery,
    cohortId
      ? admin.from("cohorts").select("name").eq("id", cohortId).maybeSingle()
      : Promise.resolve({ data: null }),
    getSiteConfig(),
  ]);

  const ev = (events ?? [])[0] as any;
  const embedded = ev ? (Array.isArray(ev.cohort) ? ev.cohort[0] : ev.cohort) : null;
  const cohortName: string | null =
    cohortRow?.data?.name ?? embedded?.name ?? null;

  if (ev) {
    return {
      cohortName,
      when: formatEventWhen(ev.starts_at),
      location: ev.location ?? null,
      // A premiere is hosted on batch0 too; only `external` has a Zoom link.
      // Into the ticket page's href and both ticket emails' href="…", which
      // escape it as text only: https or nothing (lib/event-form.ts).
      externalUrl: isHostedOnBatch0(ev.live_mode) ? null : httpsUrl(ev.zoom_url),
      hosted: isHostedOnBatch0(ev.live_mode),
      eventId: ev.id,
    };
  }

  return {
    cohortName,
    when: config.settings.demoDayDate
      ? fmtDateOnly(config.settings.demoDayDate)
      : null,
    location: null,
    externalUrl: null,
    hosted: false,
    eventId: null,
  };
}

/**
 * An event instant as it should read in an email. Eastern, like every other
 * human-facing date on the site (see formatPromoDeadlines in lib/promo.ts),
 * with the zone named so a reader elsewhere isn't left guessing.
 */
function formatEventWhen(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const tz = "America/New_York";
  const date = d.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: tz,
  });
  const time = d.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: tz,
  });
  return `${date} at ${time} ET`;
}

/**
 * Send (or resend) the invite for a ticket. Admin-editable via the
 * `demo_day.ticket_invite` template; the compiled version is the fallback.
 * Returns the transport result so the admin sees a failed send instead of
 * assuming the link went out.
 */
export async function sendTicketInvite(ticket: DemoDayTicket) {
  const details = await getDemoDayDetails(ticket.cohort_id);
  const payUrl = ticketPayUrl(ticket.token);
  const amount = formatTicketAmount(ticket.amount_cents);
  return sendTemplated(TICKET_INVITE_TEMPLATE, {
    to: ticket.email,
    toName: ticket.name,
    userId: ticket.user_id,
    vars: {
      amount,
      pay_url: payUrl,
      note: ticket.note ?? "",
      demo_day_when: details.when ?? "",
      cohort_name: details.cohortName ?? "",
    },
    fallback: () =>
      Templates.demoDayTicketInvite({
        name: ticket.name,
        amountCents: ticket.amount_cents,
        payUrl,
        note: ticket.note,
        when: details.when,
        cohortName: details.cohortName,
      }),
  });
}
