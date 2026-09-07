"use client";
import { useMemo, useState } from "react";
import { buildRevenueModel } from "@/lib/revenue-model";

const dollars = (cents: number) => `$${Math.round(cents / 100).toLocaleString()}`;
const pct = (r: number) => `${Math.round(r * 100)}%`;

// Plain-language reading of an elasticity value, so the slider isn't just a
// number an admin has to interpret.
function elasticityLabel(e: number): string {
  if (e >= -0.7) return "not very price-sensitive";
  if (e >= -1.3) return "moderately price-sensitive";
  return "very price-sensitive";
}

export function RevenueExplorer(props: {
  cohortName: string;
  referencePriceCents: number;
  listPriceCents: number;
  acceptedPool: number;
  conversions: number;
  submitted: number;
  capacity: number;
  revenueToDateCents: number;
  hasCohort: boolean;
}) {
  const [elasticity, setElasticity] = useState(-1.2);

  const model = useMemo(
    () =>
      buildRevenueModel({
        referencePriceCents: props.referencePriceCents,
        referenceConversions: props.conversions,
        acceptedPool: props.acceptedPool,
        capacity: props.capacity,
        elasticity,
      }),
    [
      props.referencePriceCents,
      props.conversions,
      props.acceptedPool,
      props.capacity,
      elasticity,
    ],
  );

  if (!props.hasCohort || props.referencePriceCents <= 0) {
    return (
      <p className="text-sm text-ink-soft">
        No active cohort with a price yet — set one in{" "}
        <span className="font-medium text-ink">Cohorts</span> to model revenue.
      </p>
    );
  }

  const thin = props.acceptedPool < 5;
  const rec = model.optimum;
  const ref = model.referencePoint;
  const delta = rec.revenueCents - ref.revenueCents;
  const direction =
    rec.priceCents > ref.priceCents
      ? "raise"
      : rec.priceCents < ref.priceCents
        ? "lower"
        : "hold";

  return (
    <div className="space-y-6">
      {/* What the model is standing on — all observed, none assumed. */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Accepted" value={String(props.acceptedPool)} />
        <Stat label="Paid" value={String(props.conversions)} />
        <Stat
          label="Conversion"
          value={pct(model.assumptions.referenceRate)}
        />
        <Stat
          label="Capacity"
          value={`${props.conversions}/${props.capacity}`}
        />
        <Stat label="Current price" value={dollars(props.referencePriceCents)} />
        <Stat label="List price" value={dollars(props.listPriceCents)} />
        <Stat label="Submitted" value={String(props.submitted)} />
        <Stat
          label="Revenue to date"
          value={dollars(props.revenueToDateCents)}
        />
      </div>

      {thin && (
        <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
          Thin data: fewer than 5 accepted applicants this cohort, so the curve
          below is a projection off a very small sample — treat it as
          directional, not precise.
        </p>
      )}

      {/* The one assumed input, on a slider. */}
      <div>
        <div className="flex items-baseline justify-between">
          <label htmlFor="elasticity" className="text-sm font-medium text-ink">
            Price sensitivity
          </label>
          <span className="text-xs text-ink-faint">
            elasticity {elasticity.toFixed(1)} · {elasticityLabel(elasticity)}
          </span>
        </div>
        <input
          id="elasticity"
          type="range"
          min={-2.5}
          max={-0.4}
          step={0.1}
          value={elasticity}
          onChange={(e) => setElasticity(Number(e.target.value))}
          className="mt-2 w-full accent-phosphor"
        />
        <p className="mt-1 text-xs text-ink-faint">
          How much demand moves when price moves. We can&apos;t measure this from
          one price point, so it&apos;s the assumption to sanity-check — drag it
          and watch the recommended price respond.
        </p>
      </div>

      {/* The recommendation. */}
      <div className="rounded-xl border border-phosphor/30 bg-phosphor/[0.06] p-4">
        <p className="text-xs font-semibold uppercase tracking-wider text-phosphor-ink">
          Revenue-maximizing price
        </p>
        <p className="mt-1 text-3xl font-bold text-ink">
          {dollars(rec.priceCents)}
        </p>
        <p className="mt-2 text-sm text-ink-soft">
          {direction === "hold" ? (
            <>Today&apos;s price is already about right for this model.</>
          ) : (
            <>
              The model suggests you could{" "}
              <span className="font-semibold text-ink">
                {direction} tuition
              </span>{" "}
              from {dollars(ref.priceCents)} to {dollars(rec.priceCents)}.
            </>
          )}{" "}
          It projects{" "}
          <span className="font-semibold text-ink">
            {Math.round(rec.students)} paying students
          </span>{" "}
          ({pct(rec.fillRate)} of capacity) for{" "}
          <span className="font-semibold text-ink">
            {dollars(rec.revenueCents)}
          </span>{" "}
          in tuition — {delta >= 0 ? "up" : "down"} {dollars(Math.abs(delta))}{" "}
          vs. {dollars(ref.revenueCents)} at today&apos;s price.
        </p>
      </div>

      <RevenueChart model={model} />

      <p className="text-xs leading-relaxed text-ink-faint">
        How to read this: the curve is projected tuition revenue at each price,
        built from this cohort&apos;s real accept-to-pay conversion and capped by
        your {props.capacity} seats. The dashed line marks today&apos;s price;
        the dot marks the revenue peak. This is decision support, not a
        guarantee — the price sensitivity above is an estimate.
      </p>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-line bg-wash px-3 py-2">
      <p className="text-[11px] font-medium uppercase tracking-wider text-ink-faint">
        {label}
      </p>
      <p className="mt-0.5 text-lg font-semibold tabular-nums text-ink">
        {value}
      </p>
    </div>
  );
}

function RevenueChart({
  model,
}: {
  model: ReturnType<typeof buildRevenueModel>;
}) {
  const W = 640;
  const H = 300;
  const padL = 56;
  const padR = 16;
  const padT = 16;
  const padB = 40;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const prices = model.curve.map((p) => p.priceCents);
  const minP = Math.min(...prices);
  const maxP = Math.max(...prices);
  const maxRev = Math.max(1, ...model.curve.map((p) => p.revenueCents));

  const x = (price: number) =>
    padL + ((price - minP) / Math.max(1, maxP - minP)) * plotW;
  const yRev = (rev: number) => padT + plotH - (rev / maxRev) * plotH;

  const revPath = model.curve
    .map((p, i) => `${i === 0 ? "M" : "L"}${x(p.priceCents).toFixed(1)},${yRev(p.revenueCents).toFixed(1)}`)
    .join(" ");
  const areaPath = `${revPath} L${x(maxP).toFixed(1)},${(padT + plotH).toFixed(1)} L${x(minP).toFixed(1)},${(padT + plotH).toFixed(1)} Z`;

  const optX = x(model.optimum.priceCents);
  const optY = yRev(model.optimum.revenueCents);
  const refX = x(model.referencePoint.priceCents);

  // Four x-axis ticks and three y-axis ticks, in whole dollars.
  const xTicks = [0, 0.33, 0.66, 1].map((t) => minP + t * (maxP - minP));
  const yTicks = [0.25, 0.5, 0.75, 1].map((t) => t * maxRev);

  return (
    <div className="overflow-x-auto">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label="Projected tuition revenue by price"
        className="w-full min-w-[520px]"
      >
        {/* grid + y labels */}
        <g className="text-line" stroke="currentColor" strokeWidth={1}>
          {yTicks.map((v) => (
            <line
              key={v}
              x1={padL}
              x2={W - padR}
              y1={yRev(v)}
              y2={yRev(v)}
              opacity={0.35}
            />
          ))}
        </g>
        <g
          className="text-ink-faint"
          fill="currentColor"
          fontSize={11}
          textAnchor="end"
        >
          {yTicks.map((v) => (
            <text key={v} x={padL - 8} y={yRev(v) + 3}>
              {dollars(v)}
            </text>
          ))}
        </g>

        {/* revenue area + line */}
        <g className="text-phosphor-ink">
          <path d={areaPath} fill="currentColor" opacity={0.1} />
          <path d={revPath} fill="none" stroke="currentColor" strokeWidth={2.5} />
        </g>

        {/* today's price marker */}
        <g className="text-ink-faint" stroke="currentColor">
          <line
            x1={refX}
            x2={refX}
            y1={padT}
            y2={padT + plotH}
            strokeWidth={1.5}
            strokeDasharray="4 4"
            opacity={0.7}
          />
        </g>
        <text
          x={refX}
          y={padT + 12}
          textAnchor="middle"
          fontSize={10}
          className="text-ink-faint"
          fill="currentColor"
        >
          today
        </text>

        {/* optimum marker */}
        <g className="text-phosphor-ink">
          <circle cx={optX} cy={optY} r={5} fill="currentColor" />
        </g>
        <text
          x={Math.min(Math.max(optX, padL + 20), W - padR - 20)}
          y={Math.max(optY - 10, padT + 24)}
          textAnchor="middle"
          fontSize={11}
          fontWeight={600}
          className="text-ink"
          fill="currentColor"
        >
          {dollars(model.optimum.priceCents)}
        </text>

        {/* x axis + labels */}
        <g className="text-line" stroke="currentColor">
          <line x1={padL} x2={W - padR} y1={padT + plotH} y2={padT + plotH} />
        </g>
        <g
          className="text-ink-faint"
          fill="currentColor"
          fontSize={11}
          textAnchor="middle"
        >
          {xTicks.map((v) => (
            <text key={v} x={x(v)} y={H - padB + 20}>
              {dollars(v)}
            </text>
          ))}
          <text x={padL + plotW / 2} y={H - 4} fontSize={11} opacity={0.8}>
            Tuition price
          </text>
        </g>
      </svg>
    </div>
  );
}
