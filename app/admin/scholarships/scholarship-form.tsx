"use client";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input, Textarea, Select, Label } from "@/components/ui/input";
import { Toggle } from "@/components/ui/toggle";
import { getActionError } from "@/lib/action-error";
import {
  SCHOLARSHIP_KINDS,
  SCHOLARSHIP_KIND_LABELS,
  SCHOLARSHIP_KIND_BLURBS,
  MAX_MENTOR_CALLS,
} from "@/lib/scholarship-award";
import { saveScholarship, type ScholarshipInput } from "./actions";

export type ScholarshipFormValues = ScholarshipInput;

/** An ISO timestamp as a <input type="datetime-local"> value, in local time. */
function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function emptyScholarshipForm(): ScholarshipFormValues {
  return {
    id: null,
    slug: "",
    name: "",
    kind: "need",
    tagline: "",
    description: "",
    awardType: "discount",
    awardDollars: "",
    awardPercent: "",
    mentorCalls: "3",
    seats: "",
    opensAt: "",
    closesAt: "",
    eligibleStages: ["accepted", "enrolled"],
    enabled: true,
    sortIndex: "100",
  };
}

export function scholarshipToForm(s: {
  id: string;
  slug: string;
  name: string;
  kind: string;
  tagline: string | null;
  description: string | null;
  terms: {
    awardType: string;
    amountCents: number;
    percent: number | null;
    mentorCalls: number;
  };
  seats: number | null;
  opensAt: string | null;
  closesAt: string | null;
  eligibleStages: string[];
  enabled: boolean;
  sortIndex: number;
}): ScholarshipFormValues {
  return {
    id: s.id,
    slug: s.slug,
    name: s.name,
    kind: s.kind,
    tagline: s.tagline ?? "",
    description: s.description ?? "",
    awardType: s.terms.awardType,
    awardDollars: s.terms.amountCents ? String(s.terms.amountCents / 100) : "",
    awardPercent: s.terms.percent === null ? "" : String(s.terms.percent),
    mentorCalls: String(s.terms.mentorCalls || 3),
    seats: s.seats === null ? "" : String(s.seats),
    opensAt: toLocalInput(s.opensAt),
    closesAt: toLocalInput(s.closesAt),
    eligibleStages: s.eligibleStages,
    enabled: s.enabled,
    sortIndex: String(s.sortIndex),
  };
}

export function ScholarshipForm({ initial }: { initial: ScholarshipFormValues }) {
  const router = useRouter();
  const [v, setV] = useState<ScholarshipFormValues>(initial);
  const [error, setError] = useState<string | undefined>();
  const [saved, setSaved] = useState(false);
  const [pending, start] = useTransition();

  function set<K extends keyof ScholarshipFormValues>(
    k: K,
    value: ScholarshipFormValues[K],
  ) {
    setV((prev) => ({ ...prev, [k]: value }));
    setSaved(false);
  }

  function toggleStage(stage: string, on: boolean) {
    const next = on
      ? [...new Set([...v.eligibleStages, stage])]
      : v.eligibleStages.filter((s) => s !== stage);
    set("eligibleStages", next);
  }

  const isCalls = v.awardType === "mentor_calls";
  const usesPercent = !isCalls && v.awardPercent.trim() !== "";

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(undefined);
    start(async () => {
      try {
        const res = await saveScholarship(v);
        if (!res.ok) {
          setError(res.error);
          return;
        }
        setSaved(true);
        if (!initial.id && res.data) {
          router.push(`/admin/scholarships/${res.data.id}`);
        }
        router.refresh();
      } catch (err: any) {
        setError(getActionError(err));
      }
    });
  }

  return (
    <form onSubmit={onSubmit} className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <Label htmlFor="s-name" required>
            Name *
          </Label>
          <Input
            id="s-name"
            value={v.name}
            onChange={(e) => set("name", e.target.value)}
            placeholder="Need-based grant"
          />
        </div>
        <div>
          <Label htmlFor="s-slug">URL slug</Label>
          <Input
            id="s-slug"
            value={v.slug}
            onChange={(e) => set("slug", e.target.value)}
            placeholder="Left blank, we make one from the name"
          />
          <p className="mt-1 text-xs text-ink-faint">
            /dashboard/scholarships/<strong>{v.slug || "…"}</strong>. Changing it
            breaks any link you've already sent out.
          </p>
        </div>
      </div>

      <div>
        <Label htmlFor="s-kind">Kind</Label>
        <Select
          id="s-kind"
          value={v.kind}
          onChange={(e) => set("kind", e.target.value)}
        >
          {SCHOLARSHIP_KINDS.map((k) => (
            <option key={k} value={k}>
              {SCHOLARSHIP_KIND_LABELS[k]}
            </option>
          ))}
        </Select>
        <p className="mt-1 text-xs text-ink-faint">
          {SCHOLARSHIP_KIND_BLURBS[v.kind as keyof typeof SCHOLARSHIP_KIND_BLURBS] ??
            ""}{" "}
          This is a label — what it actually pays out is set below, so a merit
          scholarship granting mentor calls is perfectly valid.
        </p>
      </div>

      <div>
        <Label htmlFor="s-tagline">Tagline</Label>
        <Input
          id="s-tagline"
          value={v.tagline}
          onChange={(e) => set("tagline", e.target.value)}
          placeholder="One line on the card."
        />
      </div>

      <div>
        <Label htmlFor="s-description">Description</Label>
        <Textarea
          id="s-description"
          rows={4}
          value={v.description}
          onChange={(e) => set("description", e.target.value)}
          placeholder="What it's for, who it's for, and what you're looking for in an application."
        />
      </div>

      <div className="rounded-xl border border-line bg-wash p-4">
        <h3 className="mb-3 text-sm font-medium text-ink">What it's worth</h3>

        <div className="mb-4">
          <Label htmlFor="s-award-type">Pays out as</Label>
          <Select
            id="s-award-type"
            value={v.awardType}
            onChange={(e) => set("awardType", e.target.value)}
          >
            <option value="discount">Money off tuition</option>
            <option value="mentor_calls">Extra 1:1 mentor calls</option>
          </Select>
        </div>

        {isCalls ? (
          <div>
            <Label htmlFor="s-calls" required>
              Extra mentor calls *
            </Label>
            <Input
              id="s-calls"
              type="number"
              min={1}
              max={MAX_MENTOR_CALLS}
              value={v.mentorCalls}
              onChange={(e) => set("mentorCalls", e.target.value)}
            />
            <p className="mt-1 text-xs text-ink-faint">
              The student books these themselves from their 1:1 calls page. A
              credit is spent when the team actually schedules the call, not
              when they ask — and comes back if it's cancelled.
            </p>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="s-dollars">Flat amount ($)</Label>
              <Input
                id="s-dollars"
                type="number"
                min={0}
                step="1"
                value={v.awardDollars}
                disabled={usesPercent}
                onChange={(e) => set("awardDollars", e.target.value)}
                placeholder="50"
              />
            </div>
            <div>
              <Label htmlFor="s-percent">…or a percentage</Label>
              <Input
                id="s-percent"
                type="number"
                min={1}
                max={100}
                value={v.awardPercent}
                onChange={(e) => set("awardPercent", e.target.value)}
                placeholder="50"
              />
            </div>
            <p className="text-xs text-ink-faint sm:col-span-2">
              {usesPercent
                ? "A percentage wins over the flat amount, and is resolved against what the student would actually be billed — after regional pricing, any sale, and a founder pass. So it stays half of tuition even when tuition changes."
                : "A flat amount is taken off the price after every other discount, and is capped at what they actually owe. Set a percentage instead if you want it to track tuition."}
            </p>
          </div>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <div>
          <Label htmlFor="s-seats">Seats</Label>
          <Input
            id="s-seats"
            type="number"
            min={0}
            value={v.seats}
            onChange={(e) => set("seats", e.target.value)}
            placeholder="Unlimited"
          />
        </div>
        <div>
          <Label htmlFor="s-opens">Opens</Label>
          <Input
            id="s-opens"
            type="datetime-local"
            value={v.opensAt}
            onChange={(e) => set("opensAt", e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="s-closes">Closes</Label>
          <Input
            id="s-closes"
            type="datetime-local"
            value={v.closesAt}
            onChange={(e) => set("closesAt", e.target.value)}
          />
        </div>
      </div>

      <div>
        <Label>Who can apply</Label>
        <div className="mt-1 space-y-2">
          <label className="flex items-center gap-2 text-sm text-ink">
            <input
              type="checkbox"
              checked={v.eligibleStages.includes("accepted")}
              onChange={(e) => toggleStage("accepted", e.target.checked)}
              className="h-4 w-4 rounded border-line"
            />
            Accepted, not yet paid —{" "}
            <span className="text-ink-soft">
              the award comes off their checkout
            </span>
          </label>
          <label className="flex items-center gap-2 text-sm text-ink">
            <input
              type="checkbox"
              checked={v.eligibleStages.includes("enrolled")}
              onChange={(e) => toggleStage("enrolled", e.target.checked)}
              className="h-4 w-4 rounded border-line"
            />
            Already enrolled —{" "}
            <span className="text-ink-soft">
              a money award becomes a refund you approve by hand
            </span>
          </label>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Toggle
          label="Open"
          description="Off hides it from everyone who hasn't already applied."
          checked={v.enabled}
          onChange={(on) => set("enabled", on)}
        />
        <div>
          <Label htmlFor="s-sort">Sort order</Label>
          <Input
            id="s-sort"
            type="number"
            value={v.sortIndex}
            onChange={(e) => set("sortIndex", e.target.value)}
          />
          <p className="mt-1 text-xs text-ink-faint">Lower shows first.</p>
        </div>
      </div>

      {error && (
        <p className="rounded-lg border border-red-400/30 bg-red-400/5 px-3 py-2 text-xs text-red-300">
          {error}
        </p>
      )}

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending
            ? "Saving…"
            : initial.id
              ? "Save changes"
              : "Create scholarship"}
        </Button>
        {saved && <span className="text-xs text-emerald-300">Saved.</span>}
      </div>
    </form>
  );
}
