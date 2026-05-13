"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input, Textarea, Label, Select, FieldError } from "@/components/ui/input";
import { Toggle } from "@/components/ui/toggle";
import { ConfirmDialog } from "@/components/ui/dialog";
import { saveTeam, deleteTeam, type TeamInput } from "./actions";
import { getActionError } from "@/lib/action-error";

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
        label="Public showcase"
        description="When on, this team gets a public profile at /cohort/[cohort]/teams/[team]."
        checked={t.is_public}
        onChange={(v) => setT({ ...t, is_public: v })}
      />

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
              <span className="text-white">{t.name}</span>, all members, and
              any investor interests will be removed.
            </p>
            <p className="mt-2 text-amber-300/80">This cannot be undone.</p>
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
