import { Card } from "@/components/ui/card";

function pct(used: number, free: number) {
  if (free <= 0) return 0;
  return Math.min(100, Math.round((used * 100) / free));
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return `${n}`;
}

export function UsageMeter({
  inputTokens,
  outputTokens,
  billedCents,
  freeInput,
  freeOutput,
}: {
  inputTokens: number;
  outputTokens: number;
  billedCents: number;
  freeInput: number;
  freeOutput: number;
}) {
  const inPct = pct(inputTokens, freeInput);
  const outPct = pct(outputTokens, freeOutput);
  const overage = billedCents > 0;

  return (
    <Card className="!p-4">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold uppercase tracking-wider text-white/55">
          This month
        </p>
        {overage && (
          <span className="rounded-full bg-amber-300/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-200">
            Overage
          </span>
        )}
      </div>

      <div className="mt-3 space-y-3">
        <div>
          <div className="flex items-center justify-between text-[11px] text-white/55">
            <span>Input</span>
            <span>
              {fmt(inputTokens)} / {fmt(freeInput)}
            </span>
          </div>
          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-white/10">
            <div
              className={`h-full ${inPct >= 100 ? "bg-amber-300" : "bg-spark"}`}
              style={{ width: `${Math.min(100, inPct)}%` }}
            />
          </div>
        </div>
        <div>
          <div className="flex items-center justify-between text-[11px] text-white/55">
            <span>Output</span>
            <span>
              {fmt(outputTokens)} / {fmt(freeOutput)}
            </span>
          </div>
          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-white/10">
            <div
              className={`h-full ${outPct >= 100 ? "bg-amber-300" : "bg-spark"}`}
              style={{ width: `${Math.min(100, outPct)}%` }}
            />
          </div>
        </div>
      </div>

      {overage ? (
        <p className="mt-3 text-[11px] text-amber-200/85">
          ${(billedCents / 100).toFixed(2)} added to your account this month for
          overage. View on the{" "}
          <a href="/dashboard/billing" className="underline">
            billing
          </a>{" "}
          page.
        </p>
      ) : (
        <p className="mt-3 text-[11px] text-white/40">
          Free tier resets the 1st of every month.
        </p>
      )}
    </Card>
  );
}
