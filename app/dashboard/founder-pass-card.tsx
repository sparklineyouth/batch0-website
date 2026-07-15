import Link from "next/link";
import { Card } from "@/components/ui/card";
import { Ticket } from "lucide-react";
import { formatSerial } from "@/lib/founder-pass-code";

/**
 * The founder pass badge on the student dashboard.
 *
 * Only rendered for holders (see app/dashboard/page.tsx) — there is no
 * "you don't have one" state on purpose. The cards are handed out in person
 * and there is no way to buy one, so advertising the pass to someone without a
 * card is just showing them a locked door.
 *
 * Server component: it renders a serial the page already fetched, and has no
 * interactivity to justify shipping JS for.
 */
export function FounderPassCard({
  serial,
  batch,
}: {
  serial: number;
  batch: string;
}) {
  return (
    <Card className="border-amber-400/30 bg-amber-400/[0.04]">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="inline-flex items-center gap-2 rounded-full bg-amber-400/10 px-2.5 py-0.5 text-xs font-semibold text-amber-200">
            <Ticket className="h-3.5 w-3.5" />
            Founder pass
          </div>
          <p className="mt-3 text-sm text-ink-soft">
            Bound to this account, for good. A priority review lane, real
            feedback, a feedback credit, the Founder Toolkit, and a public
            profile — whether or not you join this cohort.
          </p>
          <Link
            href="/pass"
            className="mt-3 inline-block text-xs font-semibold text-amber-200 underline underline-offset-4"
          >
            Open your pass →
          </Link>
        </div>
        <div className="text-right">
          <div className="text-xs uppercase tracking-wider text-ink-faint">
            {batch}
          </div>
          <div className="mt-1 font-mono text-2xl font-bold tabular-nums text-amber-200">
            {formatSerial(serial)}
          </div>
        </div>
      </div>
    </Card>
  );
}
