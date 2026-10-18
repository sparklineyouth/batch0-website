import { Check, Minus, MessageSquareOff, Users } from "lucide-react";
import { Card, StatusBadge } from "@/components/ui/card";
import { displayEmail } from "@/lib/placeholder-email";
import { getSmsSettings, hasCredentials } from "@/lib/sms/settings";
import { loadCollectWorklist, type CollectRow } from "./actions";
import { CollectControl } from "./collect-control";

export const metadata = { title: "Collect numbers · Admin" };
export const dynamic = "force-dynamic";

/**
 * The page the whole texting feature is blocked on.
 *
 * Every other surface under /admin/sms is machinery waiting for input: a
 * campaign with no opted-in numbers sends nothing, and the settings page can be
 * perfect while the outbox stays empty. So this is the one place in the section
 * where the number on screen is the constraint rather than a metric.
 *
 * The one channel that can fix it is EMAIL, which is stated on the page rather
 * than implied. Texting someone to ask permission to text them is precisely
 * what consent law prohibits, so the bootstrap has to happen out of band.
 */
export default async function SmsCollectPage() {
  const [res, settings] = await Promise.all([loadCollectWorklist(), getSmsSettings()]);

  if (!res.ok) {
    return (
      <Card>
        <p className="text-sm text-red-500">
          Couldn&rsquo;t load the worklist: {res.error}
        </p>
      </Card>
    );
  }

  const live = settings.configured && !settings.readError && hasCredentials(settings);
  const { rows, total, textable, pending, unaskable } = res.worklist;

  return (
    <div className="mx-auto max-w-6xl">
      <div>
        <h1 className="font-display text-3xl font-bold tracking-[-0.02em] text-ink">
          Collect numbers
        </h1>
        <p className="mt-1 max-w-2xl text-sm text-ink-soft">
          Who we can text, and who we can&rsquo;t yet. A number on file is not
          permission — the two are tracked separately because a campaign only
          reaches students who turned texts on.
        </p>
      </div>

      {/* The chicken-and-egg, said out loud. It is the reason the only action on
          this page is an email, and hiding it would make that action look like a
          mistake. */}
      <Card className="mt-6 border-amber-500/30 bg-amber-500/5">
        <div className="flex items-start gap-3">
          <MessageSquareOff className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" />
          <div className="text-sm text-ink-soft">
            <p className="font-medium text-ink">
              We can&rsquo;t text people to ask if we can text them.
            </p>
            <p className="mt-1 max-w-3xl">
              Consent has to be collected somewhere other than SMS, so the
              action below sends <strong className="text-ink">email</strong>. It
              asks each student to add their mobile and turn texts on at{" "}
              <span className="font-mono text-xs">/dashboard/phone</span>.
            </p>
          </div>
        </div>
      </Card>

      <Card className="mt-4">
        <p className="text-sm text-ink-soft">
          <span className="text-lg font-semibold text-ink">{textable}</span> of{" "}
          <span className="text-lg font-semibold text-ink">{total}</span>{" "}
          accepted and enrolled students can get a program text.
        </p>

        <div className="mt-5 border-t border-line pt-5">
          {live ? (
            <CollectControl count={pending} />
          ) : (
            <p className="text-sm text-ink-soft">
              The opt-in email unlocks once texting is live — a sending number
              and credentials saved at{" "}
              <a href="/admin/sms/settings" className="underline">
                Settings
              </a>
              . Asking people to turn on texts we can&rsquo;t send yet would be
              a promise we can&rsquo;t keep.
            </p>
          )}
          {live && pending > 0 && (
            <p className="mt-3 text-xs text-ink-faint">
              {pending} of {total} haven&rsquo;t turned texts on. Re-running it
              reaches whoever still hasn&rsquo;t; anyone who opted out is never
              asked again.
            </p>
          )}
          {unaskable > 0 && (
            <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">
              A further {unaskable} {unaskable === 1 ? "person has" : "people have"} no
              email address on file, so no send can reach them.
            </p>
          )}
        </div>
      </Card>

      <Card className="mt-4 !p-0 overflow-hidden">
        {rows.length === 0 ? (
          <div className="p-10 text-center">
            <Users className="mx-auto h-8 w-8 text-ink-faint" />
            <p className="mt-3 text-sm text-ink-soft">
              Nobody is accepted or enrolled yet, so there are no numbers to
              collect.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs uppercase tracking-wider text-ink-faint">
                  <th className="px-5 py-3">Student</th>
                  <th className="px-5 py-3">Status</th>
                  <th className="px-5 py-3">Number</th>
                  <th className="px-5 py-3">Texts</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <Row key={r.userId} row={r} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

function Row({ row }: { row: CollectRow }) {
  // A synthesized placeholder is never shown to a human (lib/placeholder-email),
  // and here the absence is the interesting fact: this row cannot be emailed.
  const email = displayEmail(row.email);
  return (
    <tr className="border-b border-line last:border-0 hover:bg-wash">
      <td className="px-5 py-3">
        <div className="font-medium text-ink">{row.name || "—"}</div>
        {email ? (
          <div className="font-mono text-xs text-ink-faint">{email}</div>
        ) : (
          <div className="text-xs italic text-amber-700 dark:text-amber-300">
            no email — can&rsquo;t be asked
          </div>
        )}
      </td>
      <td className="px-5 py-3">
        <StatusBadge status={row.status} />
      </td>
      <Flag
        on={row.hasNumber && row.textableNumber}
        yes="on file"
        no={row.hasNumber ? "can't be texted" : "none on file"}
      />
      <Flag
        on={row.consent}
        yes="turned on"
        no={row.underAge ? "under 13 — not offered" : row.optedOut ? "opted out" : "not turned on"}
      />
    </tr>
  );
}

/**
 * One of the two state columns. A dash, not a red cross: none of these are
 * errors — they are things nobody has got round to yet, and a wall of red on a
 * roster where almost every row is empty reads as a broken page rather than an
 * unfinished task. Each glyph is paired with a word because the glyph alone
 * tells a screen reader nothing.
 */
function Flag({ on, yes, no }: { on: boolean; yes: string; no: string }) {
  return (
    <td className="px-5 py-3">
      {on ? (
        <span className="inline-flex items-center gap-1.5 text-phosphor-ink">
          <Check className="h-4 w-4" aria-hidden="true" />
          <span className="text-xs">{yes}</span>
        </span>
      ) : (
        <span className="inline-flex items-center gap-1.5 text-ink-faint">
          <Minus className="h-4 w-4" aria-hidden="true" />
          <span className="text-xs">{no}</span>
        </span>
      )}
    </td>
  );
}
