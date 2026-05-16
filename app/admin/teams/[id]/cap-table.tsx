"use client";
import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea, FieldError } from "@/components/ui/input";
import {
  upsertHolder,
  deleteHolder,
  type HolderInput,
  type HolderKind,
} from "./cap-table-actions";
import { getActionError } from "@/lib/action-error";

type Holder = HolderInput & { id: string };

const KIND_LABELS: Record<HolderKind, string> = {
  founder: "Founder",
  option: "Option",
  safe: "SAFE",
  investor: "Investor",
  advisor: "Advisor",
};

function emptyHolder(teamId: string): HolderInput {
  return {
    team_id: teamId,
    profile_id: null,
    display_name: "",
    kind: "founder",
    shares_bp: null,
    amount_cents: null,
    valuation_cap_cents: null,
    discount_pct: null,
    vesting_start: null,
    vesting_months: null,
    cliff_months: null,
    notes: null,
  };
}

export function CapTable({
  teamId,
  rows,
  members,
}: {
  teamId: string;
  rows: Holder[];
  members: { id: string; full_name: string | null; email: string | null }[];
}) {
  const router = useRouter();
  const [editing, setEditing] = useState<HolderInput | null>(null);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | undefined>();

  const totals = useMemo(() => {
    let bp = 0;
    let safeCents = 0;
    let optionsBp = 0;
    for (const r of rows) {
      if (r.kind === "option") optionsBp += r.shares_bp ?? 0;
      else if (r.kind !== "safe") bp += r.shares_bp ?? 0;
      if (r.kind === "safe") safeCents += r.amount_cents ?? 0;
    }
    return { bp, optionsBp, safeCents };
  }, [rows]);

  function save(h: HolderInput) {
    setError(undefined);
    start(async () => {
      try {
        await upsertHolder(h);
        setEditing(null);
        router.refresh();
      } catch (e) {
        setError(getActionError(e));
      }
    });
  }

  function remove(id: string) {
    if (!confirm("Remove this cap-table row?")) return;
    setError(undefined);
    start(async () => {
      try {
        await deleteHolder(id, teamId);
        router.refresh();
      } catch (e) {
        setError(getActionError(e));
      }
    });
  }

  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wider text-white/55">
            Cap table
          </h2>
          <p className="mt-1 text-xs text-white/50">
            Founders + options + SAFEs. Investors and members can view.
          </p>
        </div>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => setEditing(emptyHolder(teamId))}
        >
          + Add row
        </Button>
      </div>

      <div className="mt-4 grid grid-cols-3 gap-3 text-xs">
        <Totals
          label="Common equity"
          value={`${(totals.bp / 100).toFixed(2)}%`}
        />
        <Totals
          label="Option pool"
          value={`${(totals.optionsBp / 100).toFixed(2)}%`}
        />
        <Totals
          label="SAFEs raised"
          value={`$${(totals.safeCents / 100).toLocaleString()}`}
        />
      </div>

      {rows.length === 0 ? (
        <p className="mt-5 text-sm text-white/50">
          No holders yet. Add founders and any SAFE/option grants.
        </p>
      ) : (
        <ul className="mt-5 divide-y divide-white/5">
          {rows.map((r) => (
            <li
              key={r.id}
              className="flex flex-wrap items-baseline justify-between gap-3 py-3"
            >
              <div className="min-w-0">
                <p className="text-sm font-medium text-white">
                  {r.display_name}{" "}
                  <span className="ml-2 rounded bg-white/5 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-white/55">
                    {KIND_LABELS[r.kind]}
                  </span>
                </p>
                <p className="mt-0.5 text-xs text-white/50">
                  {r.shares_bp != null
                    ? `${(r.shares_bp / 100).toFixed(2)}%`
                    : null}
                  {r.amount_cents
                    ? ` · $${(r.amount_cents / 100).toLocaleString()}`
                    : ""}
                  {r.valuation_cap_cents
                    ? ` · cap $${(r.valuation_cap_cents / 100).toLocaleString()}`
                    : ""}
                  {r.discount_pct ? ` · ${r.discount_pct}% disc` : ""}
                  {r.vesting_months
                    ? ` · ${r.vesting_months}mo vest${r.cliff_months ? `, ${r.cliff_months}mo cliff` : ""}`
                    : ""}
                </p>
              </div>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setEditing(r)}
                  disabled={pending}
                >
                  Edit
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => remove(r.id)}
                  disabled={pending}
                >
                  Remove
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {error && (
        <div className="mt-3">
          <FieldError>{error}</FieldError>
        </div>
      )}

      {editing && (
        <HolderEditor
          value={editing}
          members={members}
          pending={pending}
          onCancel={() => setEditing(null)}
          onSave={save}
        />
      )}
    </div>
  );
}

function Totals({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-white/10 bg-black/30 p-3">
      <p className="text-[10px] uppercase tracking-wider text-white/45">
        {label}
      </p>
      <p className="mt-1 text-sm font-semibold text-white">{value}</p>
    </div>
  );
}

function HolderEditor({
  value,
  members,
  pending,
  onCancel,
  onSave,
}: {
  value: HolderInput;
  members: { id: string; full_name: string | null; email: string | null }[];
  pending: boolean;
  onCancel: () => void;
  onSave: (h: HolderInput) => void;
}) {
  const [h, setH] = useState<HolderInput>(value);
  return (
    <div className="mt-5 rounded-xl border border-white/10 bg-black/30 p-4">
      <h3 className="text-sm font-semibold text-white">
        {value.id ? "Edit holder" : "Add holder"}
      </h3>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <Label>Holder name</Label>
          <Input
            value={h.display_name}
            onChange={(e) => setH({ ...h, display_name: e.target.value })}
            placeholder="e.g. Jane Founder"
            required
          />
        </div>
        <div>
          <Label>Kind</Label>
          <Select
            value={h.kind}
            onChange={(e) =>
              setH({ ...h, kind: e.target.value as HolderKind })
            }
          >
            {(Object.entries(KIND_LABELS) as [HolderKind, string][]).map(
              ([k, lbl]) => (
                <option key={k} value={k}>
                  {lbl}
                </option>
              ),
            )}
          </Select>
        </div>
        <div>
          <Label>Linked SparkLine Youth profile (optional)</Label>
          <Select
            value={h.profile_id ?? ""}
            onChange={(e) =>
              setH({ ...h, profile_id: e.target.value || null })
            }
          >
            <option value="">— External / unlinked —</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.full_name ?? m.email ?? m.id.slice(0, 8)}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label>Equity %</Label>
          <Input
            type="number"
            min={0}
            max={100}
            step={0.01}
            value={h.shares_bp != null ? h.shares_bp / 100 : ""}
            onChange={(e) =>
              setH({
                ...h,
                shares_bp:
                  e.target.value === ""
                    ? null
                    : Math.round(Number(e.target.value) * 100),
              })
            }
            placeholder="e.g. 25.00"
          />
        </div>
        <div>
          <Label>Amount (USD)</Label>
          <Input
            type="number"
            min={0}
            step={1}
            value={h.amount_cents != null ? Math.round(h.amount_cents / 100) : ""}
            onChange={(e) =>
              setH({
                ...h,
                amount_cents:
                  e.target.value === ""
                    ? null
                    : Math.round(Number(e.target.value) * 100),
              })
            }
            placeholder="SAFE / cash investment"
          />
        </div>
        <div>
          <Label>Valuation cap (USD)</Label>
          <Input
            type="number"
            min={0}
            step={1}
            value={
              h.valuation_cap_cents != null
                ? Math.round(h.valuation_cap_cents / 100)
                : ""
            }
            onChange={(e) =>
              setH({
                ...h,
                valuation_cap_cents:
                  e.target.value === ""
                    ? null
                    : Math.round(Number(e.target.value) * 100),
              })
            }
            placeholder="e.g. 5000000"
          />
        </div>
        <div>
          <Label>Discount %</Label>
          <Input
            type="number"
            min={0}
            max={100}
            step={0.01}
            value={h.discount_pct ?? ""}
            onChange={(e) =>
              setH({
                ...h,
                discount_pct:
                  e.target.value === "" ? null : Number(e.target.value),
              })
            }
          />
        </div>
        <div>
          <Label>Vesting start</Label>
          <Input
            type="date"
            value={h.vesting_start ?? ""}
            onChange={(e) =>
              setH({ ...h, vesting_start: e.target.value || null })
            }
          />
        </div>
        <div>
          <Label>Vesting months</Label>
          <Input
            type="number"
            min={0}
            step={1}
            value={h.vesting_months ?? ""}
            onChange={(e) =>
              setH({
                ...h,
                vesting_months:
                  e.target.value === ""
                    ? null
                    : Math.round(Number(e.target.value)),
              })
            }
            placeholder="e.g. 48"
          />
        </div>
        <div>
          <Label>Cliff months</Label>
          <Input
            type="number"
            min={0}
            step={1}
            value={h.cliff_months ?? ""}
            onChange={(e) =>
              setH({
                ...h,
                cliff_months:
                  e.target.value === ""
                    ? null
                    : Math.round(Number(e.target.value)),
              })
            }
            placeholder="e.g. 12"
          />
        </div>
        <div className="sm:col-span-2">
          <Label>Notes</Label>
          <Textarea
            rows={2}
            value={h.notes ?? ""}
            onChange={(e) => setH({ ...h, notes: e.target.value || null })}
          />
        </div>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
        <Button onClick={() => onSave(h)} disabled={pending}>
          {pending ? "Saving…" : value.id ? "Save" : "Add"}
        </Button>
      </div>
    </div>
  );
}
