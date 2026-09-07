"use client";
import { useMemo, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { Toggle } from "@/components/ui/toggle";
import { getActionError } from "@/lib/action-error";
import { savePricingSettings, type PricingSettingsInput } from "./actions";

type Initial = {
  enabled: boolean;
  percent: number;
  endsAt: string | null;
};

// datetime-local wants "YYYY-MM-DDTHH:mm" in the browser's local time; the
// stored value is an absolute instant. Convert in both directions so the
// picker shows the admin their own clock and we persist an unambiguous instant.
function isoToLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

function localInputToIso(local: string): string | null {
  if (!local) return null;
  const d = new Date(local);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// Whole-dollar sale price, mirroring lib/promo's discount() so the preview
// equals what will be charged.
function previewCents(listCents: number, percent: number): number {
  if (percent <= 0) return listCents;
  return Math.round((listCents * (100 - percent)) / 100 / 100) * 100;
}

const money = (cents: number) => `$${Math.round(cents / 100)}`;

export function PricingForm({
  initial,
  listPriceCents,
}: {
  initial: Initial;
  listPriceCents: number;
}) {
  const [enabled, setEnabled] = useState(initial.enabled);
  const [percent, setPercent] = useState(String(initial.percent));
  const [hasDeadline, setHasDeadline] = useState(initial.endsAt !== null);
  const [localEnds, setLocalEnds] = useState(isoToLocalInput(initial.endsAt));
  const [pending, start] = useTransition();
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const pct = Number(percent);
  const validPct = Number.isFinite(pct) && pct >= 0 && pct <= 90;
  const charged = useMemo(
    () => previewCents(listPriceCents, enabled && validPct ? pct : 0),
    [listPriceCents, enabled, validPct, pct],
  );

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(undefined);
    setSaved(false);
    if (!validPct) {
      setError("Discount must be between 0 and 90 percent");
      return;
    }
    const payload: PricingSettingsInput = {
      enabled,
      percent: Math.round(pct),
      endsAt: hasDeadline ? localInputToIso(localEnds) : null,
    };
    if (hasDeadline && !payload.endsAt) {
      setError("Pick a valid end date, or turn off the deadline");
      return;
    }
    start(async () => {
      try {
        const res = await savePricingSettings(payload);
        if (!res.ok) {
          setError(res.error);
          return;
        }
        setSaved(true);
      } catch (e) {
        setError(getActionError(e));
      }
    });
  }

  const off = !enabled || !validPct || pct === 0;

  return (
    <form onSubmit={onSubmit} className="space-y-6">
      <Toggle
        label="Promotion active"
        description="Master switch. When off, tuition shows and charges the full list price everywhere."
        checked={enabled}
        onChange={(v) => {
          setEnabled(v);
          setSaved(false);
        }}
      />

      <div className="grid gap-4 sm:grid-cols-[160px_1fr] sm:items-start">
        <div>
          <Label>Discount %</Label>
          <Input
            type="number"
            min={0}
            max={90}
            step={1}
            inputMode="numeric"
            value={percent}
            disabled={!enabled}
            onChange={(e) => {
              setPercent(e.target.value);
              setSaved(false);
            }}
          />
          {!validPct && (
            <p className="mt-1.5 text-xs text-red-600 dark:text-red-400">
              Enter 0–90.
            </p>
          )}
        </div>

        {/* Live preview of what this does to the price a full-price applicant
            pays — the same arithmetic checkout runs. */}
        <div className="rounded-lg border border-line bg-wash px-4 py-3">
          <p className="text-xs font-medium uppercase tracking-wider text-ink-faint">
            Tuition after discount
          </p>
          <p className="mt-1 flex items-baseline gap-2">
            {off ? (
              <span className="text-2xl font-bold text-ink">
                {money(listPriceCents)}
              </span>
            ) : (
              <>
                <span className="text-2xl font-bold text-ink">
                  {money(charged)}
                </span>
                <span className="text-sm text-ink-faint line-through">
                  {money(listPriceCents)}
                </span>
                <span className="text-sm font-medium text-phosphor-ink">
                  save {money(listPriceCents - charged)}
                </span>
              </>
            )}
          </p>
          <p className="mt-1 text-xs text-ink-faint">
            List price {money(listPriceCents)}. Regional prices get the same
            percentage.
          </p>
        </div>
      </div>

      <div>
        <Toggle
          label="Set an end date"
          description="When off, the promo runs until you turn it off. When on, it expires on its own — no cleanup needed."
          checked={hasDeadline}
          onChange={(v) => {
            setHasDeadline(v);
            setSaved(false);
          }}
        />
        {hasDeadline && (
          <div className="mt-3 max-w-xs">
            <Label>Ends at (your local time)</Label>
            <Input
              type="datetime-local"
              value={localEnds}
              disabled={!enabled}
              onChange={(e) => {
                setLocalEnds(e.target.value);
                setSaved(false);
              }}
            />
          </div>
        )}
      </div>

      {error && (
        <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-300">
          {error}
        </p>
      )}

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save discount"}
        </Button>
        {saved && (
          <span className="text-xs text-emerald-700 dark:text-emerald-300">
            Saved — live across the site.
          </span>
        )}
      </div>
    </form>
  );
}
