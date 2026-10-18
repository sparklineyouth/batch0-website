import Link from "next/link";
import { Lock, ShieldCheck } from "lucide-react";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdminArea } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { Card } from "@/components/ui/card";
import { LocalTime } from "@/components/ui/local-time";
import { isMissingSchemaError } from "@/lib/schema-ready";
import { maskE164 } from "@/lib/phone";
import { RecordOptOutForm } from "./record-opt-out";

export const metadata = { title: "SMS consent · Admin" };
export const dynamic = "force-dynamic";

const ROW_LIMIT = 500;
/** Ledger rows fetched for the visible numbers. Generous — a number accumulates
 *  one entry per opt-in or opt-out, so hundreds of numbers is still a small set. */
const LOG_LIMIT = 3000;

/**
 * Where a consent change came from. The stored value is a bare slug (0106's
 * `source` column documents the vocabulary); these are the human readings. A
 * slug with no entry here still renders — an unknown source is information, and
 * hiding it would be the opposite of what an evidence page is for.
 */
const SOURCE_LABELS: Record<string, string> = {
  dashboard_phone: "The student, at /dashboard/phone",
  admin_test: "An admin, for their own phone (campaign test)",
  sms_start: "Replied START",
  sms_stop: "Replied STOP, or asked to stop by text",
  provider_21610: "Provider reported the number as unsubscribed",
  admin: "Recorded by an admin from a request",
};

type ConsentRow = {
  phone_e164: string;
  user_id: string | null;
  party: string;
  transactional: boolean;
  opted_out_at: string | null;
  opted_out_source: string | null;
  first_opted_in_at: string | null;
  last_opted_in_at: string | null;
  updated_at: string;
};

type LogRow = {
  id: number;
  phone_e164: string;
  party: string;
  action: string;
  purposes: string[] | null;
  consent_text: string | null;
  source: string;
  source_url: string | null;
  ip: string | null;
  user_agent: string | null;
  inbound_body: string | null;
  created_at: string;
};

export default async function SmsConsentPage() {
  const { caps } = await requireAdminArea();
  const admin = createAdminClient();

  const { data: consentData, error } = await admin
    .from("messaging_consent")
    .select(
      "phone_e164, user_id, party, transactional, opted_out_at, opted_out_source, first_opted_in_at, last_opted_in_at, updated_at",
    )
    .order("updated_at", { ascending: false })
    .limit(ROW_LIMIT);

  if (error && isMissingSchemaError(error)) {
    return (
      <div className="mx-auto max-w-3xl">
        <h1 className="font-display text-3xl font-bold tracking-[-0.02em] text-ink">
          Consent
        </h1>
        <Card className="mt-6">
          <p className="text-sm text-ink-soft">
            Texting isn&rsquo;t set up yet: migration{" "}
            <code className="font-mono text-phosphor-ink">
              0106_sms_messaging.sql
            </code>{" "}
            creates the consent tables. Until then no number can be opted in
            and nothing can be texted.
          </p>
        </Card>
      </div>
    );
  }

  const rows = (consentData ?? []) as ConsentRow[];
  const phones = rows.map((r) => r.phone_e164);
  const userIds = [
    ...new Set(rows.map((r) => r.user_id).filter((id): id is string => Boolean(id))),
  ];

  const [ledger, profiles] = await Promise.all([
    loadLedger(phones),
    loadPeople(userIds),
  ]);

  // Grouped in insertion order, which the query already made
  // newest-first — so `entries[0]` is the most recent change for that number.
  const history = new Map<string, LogRow[]>();
  for (const entry of ledger.rows) {
    const bucket = history.get(entry.phone_e164);
    if (bucket) bucket.push(entry);
    else history.set(entry.phone_e164, [entry]);
  }

  const people = new Map(profiles.map((p) => [p.id, p]));

  // Opted-out numbers first. They are the rows somebody opens this page to check
  // — "did we honour the STOP, and when" — and burying them under three hundred
  // healthy rows makes the page useless for the one question it must answer
  // inside the ten business days the revocation rule allows.
  const sorted = [...rows].sort((a, b) => {
    const aOut = a.opted_out_at ? 0 : 1;
    const bOut = b.opted_out_at ? 0 : 1;
    if (aOut !== bOut) return aOut - bOut;
    return lastChangeMs(b, history) - lastChangeMs(a, history);
  });

  const optedOut = rows.filter((r) => r.opted_out_at).length;
  const sendable = rows.filter((r) => !r.opted_out_at && r.transactional).length;

  return (
    <div className="mx-auto max-w-6xl pb-16">
      <div>
        <h1 className="font-display text-3xl font-bold tracking-[-0.02em] text-ink">
          Consent
        </h1>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">
          One row per <strong>number</strong>, not per person — that is the unit a
          carrier suppresses and the unit an inbound STOP arrives from. Every
          consent here is for program texts; promotional texts are off by
          policy.
        </p>
      </div>

      {/* The legal artifact, said plainly. Everything below the fold on this
          page exists to be read by somebody who is not an engineer. */}
      <Card className="mt-5 border-phosphor/30">
        <div className="flex gap-3">
          <Lock className="mt-0.5 h-4 w-4 shrink-0 text-phosphor-ink" />
          <div>
            <p className="text-sm text-ink">
              <strong>The history below is append-only, enforced by a trigger.</strong>
            </p>
            <p className="mt-1 text-sm text-ink-soft">
              Any UPDATE or DELETE against{" "}
              <code className="font-mono text-phosphor-ink">
                messaging_consent_log
              </code>{" "}
              raises an exception — not by convention, and not only through this
              app. Each entry stores the exact sentence the person was shown at
              the moment they agreed, so rewording the opt-in copy never rewrites
              what past consent was given under. That snapshot, with its
              timestamp and IP, is the affirmative defence; a ledger you can edit
              is not evidence.
            </p>
          </div>
        </div>
      </Card>

      <div className="mt-5 flex flex-wrap items-center gap-3 text-xs text-ink-faint">
        <span className="inline-flex items-center gap-1.5">
          <ShieldCheck className="h-3.5 w-3.5" />
          {sendable.toLocaleString()} number{sendable === 1 ? "" : "s"} we may text
        </span>
        <span>·</span>
        <span>{optedOut.toLocaleString()} opted out</span>
        {can(caps, "sms.send") && (
          <>
            <span>·</span>
            <Link href="/admin/sms/collect" className="underline hover:text-ink-soft">
              Collect more numbers
            </Link>
          </>
        )}
      </div>

      {/* Revocation arrives by more than text. The privacy policy promises an
          opt-out by "any other reasonable way" within 10 business days — an
          email reply, a support request, a guardian asking us to stop texting
          their student — and this is where one of those becomes a real
          suppression the transport checks, not a note in someone's inbox. */}
      <Card className="mt-4">
        <RecordOptOutForm />
      </Card>

      <Card className="mt-4 !p-0 overflow-hidden">
        {sorted.length === 0 ? (
          <EmptyNote>
            No number has opted in yet. Nothing can be texted until one does —
            the transport refuses a number with no consent row, so this table
            being empty is the whole SMS feature being inert.
          </EmptyNote>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs uppercase tracking-wider text-ink-faint">
                  <th className="px-5 py-3">Number</th>
                  <th className="px-5 py-3">Party</th>
                  <th className="px-5 py-3">Program texts</th>
                  <th className="px-5 py-3">Opted out</th>
                  <th className="px-5 py-3">Last change</th>
                  <th className="px-5 py-3">Last opt-in</th>
                </tr>
              </thead>
              {sorted.map((r) => {
                const entries = history.get(r.phone_e164) ?? [];
                const latest = entries[0];
                const person = r.user_id ? people.get(r.user_id) : undefined;
                const sourceSlug = latest?.source ?? r.opted_out_source ?? null;
                return (
                  // One <tbody> per number, so the evidence row can span the
                  // full width and still belong to its record — a second <tr>
                  // inside the same tbody, rather than a modal that would put
                  // the consent text one click further from the row it proves.
                  <tbody
                    key={r.phone_e164}
                    className="border-b border-line last:border-0"
                  >
                    <tr className={r.opted_out_at ? "bg-red-500/[0.04]" : undefined}>
                      <td className="whitespace-nowrap px-5 pt-3 font-mono text-xs text-ink">
                        {/* Masked here too. This is a list view on a shared
                            screen, and the number is the one field that
                            identifies a minor; the last four is enough to match
                            a row against a person you are already talking to. */}
                        {maskE164(r.phone_e164)}
                      </td>
                      <td className="px-5 pt-3 text-xs text-ink-soft">{r.party}</td>
                      <td className="px-5 pt-3">
                        <YesNo value={r.transactional} muted={Boolean(r.opted_out_at)} />
                      </td>
                      <td className="whitespace-nowrap px-5 pt-3 text-xs">
                        {r.opted_out_at ? (
                          <span className="text-red-700 dark:text-red-300">
                            <LocalTime value={r.opted_out_at} mode="datetime-short" />
                          </span>
                        ) : (
                          <span className="text-ink-faint">—</span>
                        )}
                      </td>
                      <td className="px-5 pt-3 text-xs text-ink-soft">
                        {sourceSlug ? (
                          <>
                            {SOURCE_LABELS[sourceSlug] ?? sourceSlug}
                            <div className="text-[11px] text-ink-faint">
                              <LocalTime
                                value={latest?.created_at ?? r.updated_at}
                                mode="datetime-short"
                              />
                            </div>
                          </>
                        ) : (
                          <span className="text-ink-faint">—</span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-5 pt-3 text-xs text-ink-soft">
                        <LocalTime value={r.last_opted_in_at} mode="datetime-short" />
                      </td>
                    </tr>
                    <tr className={r.opted_out_at ? "bg-red-500/[0.04]" : undefined}>
                      <td colSpan={6} className="px-5 pb-3 pt-1">
                        {person && (
                          <p className="mb-1 text-[11px] text-ink-faint">
                            Collected through{" "}
                            <span className="text-ink-soft">
                              {person.full_name ?? person.email ?? r.user_id}
                            </span>
                            {/* Not an ownership claim — 0106 is explicit that
                                user_id records the account the number arrived
                                through, and a recycled number reaches a
                                different person than the one who opted in. */}
                          </p>
                        )}
                        {entries.length === 0 ? (
                          <p className="text-[11px] text-ink-faint">
                            {ledger.error
                              ? "The ledger could not be read, so no evidence is shown for this number — the consent above is unaffected."
                              : "No ledger entries for this number. That should not happen — every grant and revoke writes one before it touches the row above — so treat this number as unproven and re-collect consent before texting it."}
                          </p>
                        ) : (
                          <details>
                            <summary className="cursor-pointer text-[11px] uppercase tracking-wider text-ink-faint hover:text-ink-soft">
                              Consent evidence · {entries.length}{" "}
                              {entries.length === 1 ? "entry" : "entries"}
                            </summary>
                            <ol className="mt-2 space-y-2">
                              {entries.map((e) => (
                                <li
                                  key={e.id}
                                  className="rounded-lg border border-line bg-paper p-3"
                                >
                                  <div className="flex flex-wrap items-center gap-2">
                                    <Chip tone={e.action === "grant" ? "ok" : "bad"}>
                                      {e.action}
                                    </Chip>
                                    <span className="text-[11px] text-ink-soft">
                                      {(e.purposes ?? []).join(", ") || "—"}
                                    </span>
                                    <span className="text-[11px] text-ink-faint">
                                      <LocalTime value={e.created_at} mode="datetime" />
                                    </span>
                                    <span className="text-[11px] text-ink-faint">
                                      as {e.party}
                                    </span>
                                  </div>
                                  {e.consent_text && (
                                    // Verbatim, unwrapped, un-truncated. This
                                    // string IS the evidence; abridging it for
                                    // layout would defeat the column's purpose.
                                    <blockquote className="mt-2 border-l-2 border-phosphor/40 pl-3 text-xs leading-relaxed text-ink">
                                      {e.consent_text}
                                    </blockquote>
                                  )}
                                  {e.inbound_body && (
                                    <p className="mt-2 font-mono text-xs text-ink-soft">
                                      Inbound: “{e.inbound_body}”
                                    </p>
                                  )}
                                  <dl className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-[11px] text-ink-faint">
                                    <Meta label="Source">
                                      {SOURCE_LABELS[e.source] ?? e.source}
                                    </Meta>
                                    {e.source_url && (
                                      <Meta label="Page">{e.source_url}</Meta>
                                    )}
                                    {/* Nullable on purpose in 0106: an inbound
                                        STOP has no IP, and a fabricated one
                                        would be worse evidence than an honest
                                        absence. */}
                                    <Meta label="IP">
                                      {e.ip ?? "not captured (arrived by text)"}
                                    </Meta>
                                    {e.user_agent && (
                                      <Meta label="Browser">
                                        <span className="break-all">{e.user_agent}</span>
                                      </Meta>
                                    )}
                                  </dl>
                                </li>
                              ))}
                            </ol>
                          </details>
                        )}
                      </td>
                    </tr>
                  </tbody>
                );
              })}
            </table>
          </div>
        )}
      </Card>

      {rows.length === ROW_LIMIT && (
        <p className="mt-3 text-xs text-ink-faint">
          Showing the {ROW_LIMIT} most recently changed numbers.
        </p>
      )}
      {error && !isMissingSchemaError(error) && (
        <p className="mt-3 text-xs text-red-500">
          Consent records could not be read: {error.message}
        </p>
      )}
      {ledger.error && (
        <p className="mt-3 text-xs text-red-500">
          The consent ledger could not be read, so no evidence is shown above:{" "}
          {ledger.error}
        </p>
      )}
    </div>
  );
}

/**
 * The append-only ledger for the numbers on screen.
 *
 * Degrades to an empty list with the reason attached rather than throwing: the
 * consent state above it is readable on its own, and losing the whole page
 * because the evidence query timed out would hide the one thing an admin came
 * here to check ("did we honour the STOP") behind the nice-to-have.
 */
async function loadLedger(
  phones: string[],
): Promise<{ rows: LogRow[]; error: string | null }> {
  if (phones.length === 0) return { rows: [], error: null };
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("messaging_consent_log")
    .select(
      "id, phone_e164, party, action, purposes, consent_text, source, source_url, ip, user_agent, inbound_body, created_at",
    )
    .in("phone_e164", phones)
    .order("created_at", { ascending: false })
    .limit(LOG_LIMIT);
  if (error) return { rows: [], error: error.message };
  return { rows: (data ?? []) as LogRow[], error: null };
}

type Person = { id: string; full_name: string | null; email: string | null };

/** Names for the accounts the numbers arrived through. Best-effort by design. */
async function loadPeople(userIds: string[]): Promise<Person[]> {
  if (userIds.length === 0) return [];
  const admin = createAdminClient();
  const { data } = await admin
    .from("profiles")
    .select("id, full_name, email")
    .in("id", userIds);
  return (data ?? []) as Person[];
}

/** When this number's state last moved — ledger first, the row's own stamps after. */
function lastChangeMs(row: ConsentRow, history: Map<string, LogRow[]>): number {
  const latest = history.get(row.phone_e164)?.[0]?.created_at;
  const at = latest ?? row.opted_out_at ?? row.last_opted_in_at ?? row.updated_at;
  const ms = new Date(at).getTime();
  return Number.isNaN(ms) ? 0 : ms;
}

function YesNo({ value, muted }: { value: boolean; muted: boolean }) {
  if (!value) return <span className="text-xs text-ink-faint">no</span>;
  // An opted-out number keeps its purpose flags — 0106 leaves them alone so a
  // later START restores exactly what was agreed rather than widening it — so a
  // "yes" under a live opt-out has to read as inactive, not as permission.
  return (
    <Chip tone={muted ? "muted" : "ok"}>{muted ? "yes · suppressed" : "yes"}</Chip>
  );
}

function Meta({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex gap-1.5">
      <dt className="uppercase tracking-wider">{label}</dt>
      <dd className="text-ink-soft">{children}</dd>
    </div>
  );
}

type Tone = "ok" | "bad" | "muted";

const TONE_CHIP: Record<Tone, string> = {
  ok: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  bad: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300",
  muted: "border-line bg-wash text-ink-faint",
};

function Chip({ children, tone }: { children: React.ReactNode; tone: Tone }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-lg border px-2 py-0.5 text-[11px] font-medium ${TONE_CHIP[tone]}`}
    >
      {children}
    </span>
  );
}

function EmptyNote({ children }: { children: React.ReactNode }) {
  return <p className="p-6 text-sm text-ink-soft">{children}</p>;
}
