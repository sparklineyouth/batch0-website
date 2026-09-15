"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input, Textarea, Select, Label, FieldError } from "@/components/ui/input";
import { getActionError } from "@/lib/action-error";
import { createTeamThread } from "@/app/admin/discussions/actions";
import { THREAD_BODY_MAX, THREAD_TITLE_MAX } from "@/lib/discussions-access";

/** The team starts a cohort discussion — a prompt, an intro thread. */
export function TeamThreadForm({
  cohorts,
  defaultCohortId,
}: {
  cohorts: { id: string; name: string }[];
  defaultCohortId?: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [cohortId, setCohortId] = useState(defaultCohortId ?? cohorts[0]?.id ?? "");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [pinned, setPinned] = useState(false);
  const [err, setErr] = useState<string | undefined>();
  const [pending, start] = useTransition();

  if (!open) {
    return (
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
        Start a cohort discussion
      </Button>
    );
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(undefined);
    start(async () => {
      try {
        const { id } = await createTeamThread({ cohortId, title, body, pinned });
        setTitle("");
        setBody("");
        setPinned(false);
        setOpen(false);
        router.push(`/admin/discussions/${id}`);
        router.refresh();
      } catch (e) {
        setErr(getActionError(e));
      }
    });
  }

  return (
    <form onSubmit={submit} className="space-y-4 rounded-xl border border-line bg-wash p-5">
      <div className="grid gap-4 sm:grid-cols-[1fr_2fr]">
        <div>
          <Label htmlFor="tt-cohort" required>
            Cohort
          </Label>
          <Select
            id="tt-cohort"
            value={cohortId}
            onChange={(e) => setCohortId(e.target.value)}
            required
          >
            {cohorts.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label htmlFor="tt-title" required>
            Title
          </Label>
          <Input
            id="tt-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={THREAD_TITLE_MAX}
            placeholder="e.g. Introduce yourself"
            required
          />
        </div>
      </div>
      <div>
        <Label htmlFor="tt-body" required>
          Post
        </Label>
        <Textarea
          id="tt-body"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          maxLength={THREAD_BODY_MAX}
          rows={5}
          required
          error={err}
        />
        <FieldError id="tt-body-error">{err}</FieldError>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="flex cursor-pointer items-center gap-2 text-sm text-ink-soft">
          <input
            type="checkbox"
            checked={pinned}
            onChange={(e) => setPinned(e.target.checked)}
            className="h-4 w-4 rounded border-line accent-phosphor"
          />
          Pin to the top of the board
        </label>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={pending}
            onClick={() => setOpen(false)}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            size="sm"
            disabled={pending || !cohortId || !title.trim() || !body.trim()}
          >
            {pending ? "Posting…" : "Post to cohort"}
          </Button>
        </div>
      </div>
    </form>
  );
}
