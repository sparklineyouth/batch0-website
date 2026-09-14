import { Phone } from "lucide-react";
import { Card } from "@/components/ui/card";
import { getAcceptedMissingPhone } from "./actions";
import { PhoneRequestControl } from "./phone-request-control";

export const metadata = { title: "Phone requests · Admin" };
export const dynamic = "force-dynamic";

/**
 * The "collect phone numbers" send.
 *
 * Students accepted before the application form asked for a phone number have
 * none on file. This page emails those who are still missing one and points
 * them at /dashboard/phone. The audience is re-resolved server-side on send,
 * so this list is a preview, not the source of truth for who gets mailed.
 */
export default async function PhoneRequestPage() {
  const audience = await getAcceptedMissingPhone();

  if (!audience.ok) {
    return (
      <Card className="p-5">
        <p className="text-sm text-red-500">
          Couldn't load the audience: {audience.error}
        </p>
      </Card>
    );
  }

  const recipients = audience.recipients;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-xl font-bold tracking-tight text-ink">
          <Phone className="h-5 w-5 text-phosphor-ink" />
          Request phone numbers
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-ink-soft">
          New applicants give their phone number on the form. Students accepted
          before we asked for one don't have it on file. This sends them a short
          email that links to{" "}
          <span className="font-mono text-xs text-ink">/dashboard/phone</span>,
          where they enter it. It's safe to run again — anyone who's since added
          a number drops off the list automatically.
        </p>
      </div>

      <Card className="p-5">
        <p className="text-sm text-ink-soft">
          <span className="text-lg font-semibold text-ink">
            {recipients.length}
          </span>{" "}
          accepted student{recipients.length === 1 ? "" : "s"} still missing a
          phone number.
        </p>

        {recipients.length > 0 && (
          <ul className="mt-4 max-h-64 divide-y divide-line overflow-y-auto rounded-lg border border-line">
            {recipients.map((r) => (
              <li
                key={r.userId}
                className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
              >
                <span className="truncate text-ink">{r.name ?? "—"}</span>
                <span className="truncate font-mono text-xs text-ink-faint">
                  {r.email}
                </span>
              </li>
            ))}
          </ul>
        )}

        <div className="mt-5">
          <PhoneRequestControl count={recipients.length} />
        </div>
      </Card>
    </div>
  );
}
