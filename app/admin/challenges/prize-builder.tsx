"use client";
import { ChevronDown, ChevronUp, Gift, Plus, Sparkles, Trash2, Trophy } from "lucide-react";
import { Input, Label, Textarea } from "@/components/ui/input";
import {
  MAX_PRIZES,
  PRIZE_KINDS,
  PRIZE_KIND_LABELS,
  newItemId,
  type ChallengePrize,
  type PrizeKind,
} from "@/lib/challenges-shared";
import { ImageField } from "./image-field";
import { IconBtn } from "./challenge-question-builder";

const KIND_ICON = { cash: Trophy, item: Gift, perk: Sparkles } as const;

const PRESETS: { label: string; make: () => ChallengePrize }[] = [
  {
    label: "Cash prize",
    make: () => ({ id: newItemId(), place: "1st place", kind: "cash", title: "", description: "", valueCents: 50000, quantity: 1, imageUrl: null }),
  },
  {
    label: "Item (e.g. Meta glasses)",
    make: () => ({ id: newItemId(), place: "Grand prize", kind: "item", title: "Ray-Ban Meta AI glasses", description: "", valueCents: 29900, quantity: 1, imageUrl: null }),
  },
  {
    label: "Perk",
    make: () => ({ id: newItemId(), place: "Every finalist", kind: "perk", title: "1:1 mentor call", description: "", valueCents: null, quantity: 1, imageUrl: null }),
  },
];

function dollars(cents: number | null) {
  return cents == null ? "" : String(cents / 100);
}
function cents(d: string): number | null {
  const t = d.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
}

/** Prizes: cash, physical items with a photo, or perks. */
export function PrizeBuilder({
  value,
  onChange,
}: {
  value: ChallengePrize[];
  onChange: (next: ChallengePrize[]) => void;
}) {
  function update(i: number, patch: Partial<ChallengePrize>) {
    onChange(value.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  }
  function move(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= value.length) return;
    const next = value.slice();
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  }

  return (
    <div className="space-y-3">
      {value.length === 0 && (
        <p className="rounded-xl border border-dashed border-line px-4 py-6 text-center text-sm text-ink-faint">
          No prizes yet. Add cash, a physical item (with a photo), or a perk.
        </p>
      )}
      {value.map((p, i) => {
        const Icon = KIND_ICON[p.kind];
        return (
          <section key={p.id} className="rounded-xl border border-line bg-paper p-4">
            <div className="flex gap-4">
              {p.kind === "cash" ? (
                <div className="flex h-20 w-20 shrink-0 items-center justify-center rounded-lg bg-phosphor text-on-phosphor">
                  <Icon className="h-7 w-7" />
                </div>
              ) : (
                <ImageField compact label="Prize photo" value={p.imageUrl} onChange={(url) => update(i, { imageUrl: url })} />
              )}
              <div className="min-w-0 flex-1 space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <div className="inline-flex rounded-md border border-line p-0.5" role="radiogroup" aria-label="Prize type">
                    {PRIZE_KINDS.map((k) => (
                      <button
                        key={k}
                        type="button"
                        role="radio"
                        aria-checked={p.kind === k}
                        onClick={() => update(i, { kind: k as PrizeKind })}
                        className={`rounded px-2.5 py-1 text-[12px] font-medium ${
                          p.kind === k ? "bg-ink text-paper" : "text-ink-soft hover:text-ink"
                        }`}
                      >
                        {PRIZE_KIND_LABELS[k]}
                      </button>
                    ))}
                  </div>
                  <div className="ml-auto flex items-center">
                    <IconBtn label="Move up" disabled={i === 0} onClick={() => move(i, -1)}>
                      <ChevronUp className="h-4 w-4" />
                    </IconBtn>
                    <IconBtn label="Move down" disabled={i === value.length - 1} onClick={() => move(i, 1)}>
                      <ChevronDown className="h-4 w-4" />
                    </IconBtn>
                    <IconBtn label="Remove prize" danger onClick={() => onChange(value.filter((_, j) => j !== i))}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </IconBtn>
                  </div>
                </div>
                <div className="grid gap-3 sm:grid-cols-[10rem_minmax(0,1fr)]">
                  <div>
                    <Label htmlFor={`${p.id}-place`}>Place / award</Label>
                    <Input id={`${p.id}-place`} value={p.place} onChange={(e) => update(i, { place: e.target.value })} placeholder="1st place" />
                  </div>
                  <div>
                    <Label htmlFor={`${p.id}-title`}>{p.kind === "cash" ? "Title (optional)" : "What they win"}</Label>
                    <Input
                      id={`${p.id}-title`}
                      value={p.title}
                      onChange={(e) => update(i, { title: e.target.value })}
                      placeholder={p.kind === "cash" ? "Defaults to the amount, e.g. $500" : p.kind === "item" ? "Ray-Ban Meta AI glasses" : "1:1 call with a founder"}
                    />
                  </div>
                </div>
                <div className="grid gap-3 sm:grid-cols-[10rem_7rem_minmax(0,1fr)]">
                  <div>
                    <Label htmlFor={`${p.id}-val`}>{p.kind === "cash" ? "Amount (USD)" : "Value (USD, optional)"}</Label>
                    <Input id={`${p.id}-val`} type="number" min={0} step="0.01" value={dollars(p.valueCents)} onChange={(e) => update(i, { valueCents: cents(e.target.value) })} placeholder="500" />
                  </div>
                  <div>
                    <Label htmlFor={`${p.id}-qty`}>Winners</Label>
                    <Input id={`${p.id}-qty`} type="number" min={1} value={p.quantity} onChange={(e) => update(i, { quantity: Math.max(1, Number(e.target.value) || 1) })} />
                  </div>
                  <div>
                    <Label htmlFor={`${p.id}-desc`}>Details (optional)</Label>
                    <Textarea id={`${p.id}-desc`} rows={1} className="!min-h-10" value={p.description} onChange={(e) => update(i, { description: e.target.value })} placeholder="Shipped to your door, US only" />
                  </div>
                </div>
              </div>
            </div>
          </section>
        );
      })}
      {value.length < MAX_PRIZES && (
        <div className="flex flex-wrap gap-2">
          {PRESETS.map((pr) => (
            <button
              key={pr.label}
              type="button"
              onClick={() => onChange([...value, pr.make()])}
              className="inline-flex items-center gap-1.5 rounded-md border border-line bg-paper px-3 py-2 text-[13px] font-medium text-ink hover:border-ink/30"
            >
              <Plus className="h-3.5 w-3.5" /> {pr.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
