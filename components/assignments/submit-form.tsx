"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input, Textarea, Label, FieldError } from "@/components/ui/input";
import { submitAssignment } from "@/app/dashboard/assignments/actions";
import { getActionError } from "@/lib/action-error";
import { LIMITS, isGoogleLink, type SubmissionType } from "@/lib/assignments";

/** Hand in or edit one assignment. Used by /dashboard and the installed app. */
export function SubmitForm({
  assignmentId,
  type,
  initial,
  pastDue,
}: {
  assignmentId: string;
  type: SubmissionType;
  initial: { body: string; link: string } | null;
  pastDue: boolean;
}) {
  const router = useRouter();
  const [body, setBody] = useState(initial?.body ?? "");
  const [link, setLink] = useState(initial?.link ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, start] = useTransition();
  const showLink = type !== "text";

  function save() {
    setError(null);
    setSaved(false);
    start(async () => {
      try {
        const res = await submitAssignment({ assignmentId, body, linkUrl: showLink ? link : null });
        if (!res.ok) {
          setError(res.error);
          return;
        }
        setSaved(true);
        router.refresh();
      } catch (e) {
        setError(getActionError(e));
      }
    });
  }

  const driveHint = showLink && link.trim() && isGoogleLink(link.trim());

  return (
    <div className="space-y-4">
      {showLink && (
        <div>
          <Label htmlFor="assignment-link">{type === "link" ? "Link" : "Link (optional)"}</Label>
          <Input
            id="assignment-link"
            type="url"
            inputMode="url"
            placeholder="https://docs.google.com/…"
            value={link}
            maxLength={LIMITS.link}
            onChange={(e) => setLink(e.target.value)}
          />
          <p className="mt-1 text-xs text-ink-faint">
            {driveHint
              ? "Set sharing to “Anyone with the link can view”."
              : "Google Drive or Docs links work best."}
          </p>
        </div>
      )}
      <div>
        <Label htmlFor="assignment-body">
          {type === "text" ? "Your answer" : type === "link" ? "Note (optional)" : "Your answer (or a link above)"}
        </Label>
        <Textarea
          id="assignment-body"
          rows={type === "link" ? 3 : 8}
          value={body}
          maxLength={LIMITS.body}
          onChange={(e) => setBody(e.target.value)}
        />
      </div>
      <FieldError>{error}</FieldError>
      {saved && !error && (
        <p className="text-xs text-emerald-700 dark:text-emerald-300">Submitted.</p>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-ink-faint">
          {pastDue ? "Past due — it'll be marked late." : "You can edit until it's reviewed."}
        </p>
        <Button onClick={save} disabled={pending}>
          {pending ? "Saving…" : initial ? "Update" : "Submit"}
        </Button>
      </div>
    </div>
  );
}
