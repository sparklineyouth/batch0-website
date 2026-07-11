"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input, Textarea, Label, Select, FieldError } from "@/components/ui/input";
import { Toggle } from "@/components/ui/toggle";
import { ConfirmDialog } from "@/components/ui/dialog";
import { saveTeam, deleteTeam, type TeamInput } from "./actions";
import { getActionError } from "@/lib/action-error";

function slugifyClient(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

type Cohort = { id: string; name: string };

export function TeamForm({
  initial,
  cohorts,
}: {
  initial: TeamInput;
  cohorts: Cohort[];
}) {
  const router = useRouter();
  const [t, setT] = useState<TeamInput>(initial);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | undefined>();
  const [confirmDel, setConfirmDel] = useState(false);

  function save() {
    setError(undefined);
    start(async () => {
      try {
        const id = await saveTeam(t);
        router.push(`/admin/teams/${id}`);
        router.refresh();
      } catch (e: any) {
        setError(getActionError(e));
      }
    });
  }

  function executeDelete() {
    if (!t.id) return;
    start(async () => {
      try {
        await deleteTeam(t.id!);
        router.push("/admin/teams");
        router.refresh();
      } catch (e: any) {
        setError(getActionError(e));
      }
    });
  }

  return (
    <div className="space-y-5">
      <div>
        <Label>Team name</Label>
        <Input
          required
          value={t.name}
          onChange={(e) => setT({ ...t, name: e.target.value })}
        />
      </div>
      <div>
        <Label>Tagline</Label>
        <Input
          value={t.tagline ?? ""}
          onChange={(e) => setT({ ...t, tagline: e.target.value })}
          placeholder="One sentence pitch"
        />
      </div>
      <div>
        <Label>Description</Label>
        <Textarea
          rows={5}
          value={t.description ?? ""}
          onChange={(e) => setT({ ...t, description: e.target.value })}
          placeholder="Problem, solution, who you serve…"
        />
      </div>
      <div>
        <Label>Cohort</Label>
        <Select
          value={t.cohort_id}
          onChange={(e) => setT({ ...t, cohort_id: e.target.value })}
          required
        >
          <option value="">— Pick cohort —</option>
          {cohorts.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <Label>Logo URL</Label>
          <Input
            type="url"
            value={t.logo_url ?? ""}
            onChange={(e) => setT({ ...t, logo_url: e.target.value })}
          />
        </div>
        <div>
          <Label>Website URL</Label>
          <Input
            type="url"
            value={t.website_url ?? ""}
            onChange={(e) => setT({ ...t, website_url: e.target.value })}
          />
        </div>
        <div>
          <Label>Pitch deck URL</Label>
          <Input
            type="url"
            value={t.pitch_deck_url ?? ""}
            onChange={(e) => setT({ ...t, pitch_deck_url: e.target.value })}
          />
        </div>
        <div>
          <Label>Pitch video URL</Label>
          <Input
            type="url"
            value={t.pitch_video_url ?? ""}
            onChange={(e) => setT({ ...t, pitch_video_url: e.target.value })}
            placeholder="YouTube, Loom, etc."
          />
        </div>
      </div>
      <Toggle
        label="Public team page"
        description={`When on, ${t.id ? `${typeof window !== "undefined" ? window.location.origin : ""}/teams/${slugifyClient(t.name)}` : "the team's slug"} is publicly indexable.`}
        checked={t.is_public}
        onChange={(v) => setT({ ...t, is_public: v })}
      />

      <div>
        <Label>Public blurb (overrides description on the public page)</Label>
        <Textarea
          rows={3}
          value={t.public_blurb ?? ""}
          onChange={(e) =>
            setT({ ...t, public_blurb: e.target.value || null })
          }
          placeholder="The 60-second version of what you're building."
        />
      </div>
      <div>
        <Label>Demo video URL (YouTube / Loom)</Label>
        <Input
          type="url"
          value={t.demo_video_url ?? ""}
          onChange={(e) =>
            setT({ ...t, demo_video_url: e.target.value || null })
          }
          placeholder="Embedded on the public team page."
        />
      </div>

      {/* Cap-table snapshot. Optional — leave everything blank to hide
          the section from investor views. Inputs are in WHOLE DOLLARS,
          converted to cents on the way in/out so the DB stays in cents
          (matches the rest of the app). */}
      <details className="rounded-lg border border-line bg-wash p-4">
        <summary className="cursor-pointer select-none text-sm font-semibold text-ink">
          Cap-table (optional)
          <span className="ml-2 text-xs font-normal text-ink-faint">
            Fundraising snapshot — shown to investors when populated.
          </span>
        </summary>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <Label>Round kind</Label>
            <Select
              value={t.round_kind ?? ""}
              onChange={(e) =>
                setT({
                  ...t,
                  round_kind:
                    (e.target.value as TeamInput["round_kind"]) || null,
                })
              }
            >
              <option value="">— Not raising —</option>
              <option value="pre_seed">Pre-seed</option>
              <option value="safe">SAFE</option>
              <option value="angel">Angel</option>
              <option value="seed">Seed</option>
              <option value="grant">Grant</option>
              <option value="other">Other</option>
            </Select>
          </div>
          <div>
            <Label>Closed on</Label>
            <Input
              type="date"
              value={t.round_closed_on ?? ""}
              onChange={(e) =>
                setT({ ...t, round_closed_on: e.target.value || null })
              }
            />
          </div>
          <div>
            <Label>Raised (USD)</Label>
            <Input
              type="number"
              min={0}
              step={1}
              value={
                t.raised_cents != null ? Math.round(t.raised_cents / 100) : ""
              }
              onChange={(e) => {
                const v = e.target.value;
                setT({
                  ...t,
                  raised_cents: v === "" ? null : Math.round(Number(v) * 100),
                });
              }}
              placeholder="e.g. 50000"
            />
          </div>
          <div>
            <Label>Post-money valuation (USD)</Label>
            <Input
              type="number"
              min={0}
              step={1}
              value={
                t.post_money_cents != null
                  ? Math.round(t.post_money_cents / 100)
                  : ""
              }
              onChange={(e) => {
                const v = e.target.value;
                setT({
                  ...t,
                  post_money_cents:
                    v === "" ? null : Math.round(Number(v) * 100),
                });
              }}
              placeholder="e.g. 500000"
            />
          </div>
          <div className="sm:col-span-2">
            <Label>Lead investor</Label>
            <Input
              value={t.lead_investor ?? ""}
              onChange={(e) =>
                setT({ ...t, lead_investor: e.target.value || null })
              }
              placeholder="e.g. Acme Ventures"
            />
          </div>
        </div>
      </details>

      {error && <FieldError>{error}</FieldError>}

      <div className="flex flex-wrap items-center justify-between gap-3 pt-3">
        <div>
          {t.id && (
            <Button
              variant="danger"
              onClick={() => setConfirmDel(true)}
              disabled={pending}
            >
              Delete team
            </Button>
          )}
        </div>
        <Button onClick={save} disabled={pending}>
          {pending ? "Saving…" : t.id ? "Save changes" : "Create team"}
        </Button>
      </div>

      <ConfirmDialog
        open={confirmDel}
        title="Delete team?"
        description={
          <>
            <p>
              <span className="text-ink">{t.name}</span>, all members, and
              any investor interests will be removed.
            </p>
            <p className="mt-2 text-amber-700 dark:text-amber-300">This cannot be undone.</p>
          </>
        }
        confirmLabel="Delete"
        destructive
        pending={pending}
        onConfirm={executeDelete}
        onCancel={() => !pending && setConfirmDel(false)}
      />
    </div>
  );
}
