"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ShieldCheck, Users } from "lucide-react";
import { Button, ButtonLink } from "@/components/ui/button";
import { Input, Textarea, Label, FieldError } from "@/components/ui/input";
import { getActionError } from "@/lib/action-error";
import { createThread } from "@/app/dashboard/discussions/actions";
import {
  THREAD_BODY_MAX,
  THREAD_TITLE_MAX,
  type DiscussionVisibility,
} from "@/lib/discussions-access";

/**
 * The student composer. The audience choice is the whole point of the form,
 * so it's the first thing on it and it says exactly who will see the post —
 * a student picking "the team" should never wonder whether a classmate can
 * read it.
 */
export function NewThreadForm({
  initialVisibility = "cohort",
  cohortName,
  canPostToCohort,
}: {
  initialVisibility?: DiscussionVisibility;
  cohortName: string | null;
  /** False when the student has no cohort assigned yet — questions only. */
  canPostToCohort: boolean;
}) {
  const router = useRouter();
  const [visibility, setVisibility] = useState<DiscussionVisibility>(
    canPostToCohort ? initialVisibility : "admin",
  );
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [err, setErr] = useState<string | undefined>();
  const [pending, start] = useTransition();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(undefined);
    start(async () => {
      try {
        const { id } = await createThread({ visibility, title, body });
        router.push(`/dashboard/discussions/${id}`);
        router.refresh();
      } catch (e) {
        setErr(getActionError(e));
      }
    });
  }

  const isPrivate = visibility === "admin";

  return (
    <form onSubmit={submit} className="space-y-6">
      <fieldset>
        <legend className="mb-2 block text-xs font-mono font-medium uppercase tracking-wider text-ink-soft">
          Who can see this
        </legend>
        <div role="radiogroup" aria-label="Who can see this" className="grid gap-2 sm:grid-cols-2">
          <AudienceOption
            selected={!isPrivate}
            disabled={!canPostToCohort}
            onSelect={() => setVisibility("cohort")}
            icon={Users}
            title={cohortName ? `Everyone in ${cohortName}` : "Everyone in my cohort"}
            hint={
              canPostToCohort
                ? "A discussion. Your cohort and the team can read and reply."
                : "Available once you're assigned to a cohort."
            }
          />
          <AudienceOption
            selected={isPrivate}
            onSelect={() => setVisibility("admin")}
            icon={ShieldCheck}
            title="The batch0 team only"
            hint="A private question. Only you and the team can see it — no other student."
          />
        </div>
      </fieldset>

      <div>
        <Label htmlFor="thread-title" required>
          {isPrivate ? "Your question, in a line" : "Title"}
        </Label>
        <Input
          id="thread-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={THREAD_TITLE_MAX}
          placeholder={
            isPrivate
              ? "e.g. Can I switch teams after week 1?"
              : "e.g. Who's working on something in edtech?"
          }
          required
        />
      </div>

      <div>
        <Label htmlFor="thread-body" required>
          {isPrivate ? "Details" : "Post"}
        </Label>
        <Textarea
          id="thread-body"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          maxLength={THREAD_BODY_MAX}
          rows={7}
          placeholder={
            isPrivate
              ? "Say as much as helps us answer well. Nobody but the team reads this."
              : "Kick it off. Be specific — the best threads ask something concrete."
          }
          required
          error={err}
        />
        <FieldError id="thread-body-error">{err}</FieldError>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={pending || !title.trim() || !body.trim()}>
          {pending ? "Posting…" : isPrivate ? "Send to the team" : "Post to cohort"}
        </Button>
        <ButtonLink href="/dashboard/discussions" variant="ghost">
          Cancel
        </ButtonLink>
      </div>
    </form>
  );
}

function AudienceOption({
  selected,
  disabled = false,
  onSelect,
  icon: Icon,
  title,
  hint,
}: {
  selected: boolean;
  disabled?: boolean;
  onSelect: () => void;
  icon: typeof Users;
  title: string;
  hint: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onSelect}
      className={`press flex items-start gap-3 rounded-md border p-4 text-left ${
        selected
          ? "border-ink bg-wash"
          : "border-line bg-paper hover:border-ink/30"
      } disabled:cursor-not-allowed disabled:opacity-50`}
    >
      <Icon
        className={`mt-0.5 h-4 w-4 shrink-0 ${selected ? "text-phosphor-ink" : "text-ink-faint"}`}
      />
      <span>
        <span className="block text-sm font-medium text-ink">{title}</span>
        <span className="mt-0.5 block text-xs leading-relaxed text-ink-soft">{hint}</span>
      </span>
    </button>
  );
}
