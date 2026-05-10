"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input, Textarea, Label, FieldError } from "@/components/ui/input";
import { gradeSubmission, reopenSubmission } from "../actions";
import { ExternalLink, FileText } from "lucide-react";

export function GradingPanel({
  submissionId,
  content,
  links,
  files,
  submittedAt,
  status,
  initialGrade,
  initialFeedback,
}: {
  submissionId: string;
  content: string | null;
  links: { title: string; url: string }[];
  files: { name: string; url: string | null }[];
  submittedAt: string | null;
  status: "draft" | "submitted" | "graded";
  initialGrade: string;
  initialFeedback: string;
}) {
  const router = useRouter();
  const [grade, setGrade] = useState(initialGrade);
  const [feedback, setFeedback] = useState(initialFeedback);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | undefined>();

  function save() {
    setError(undefined);
    start(async () => {
      try {
        await gradeSubmission({ submissionId, grade, feedback });
        router.refresh();
      } catch (e: any) {
        setError(e.message);
      }
    });
  }

  function reopen() {
    setError(undefined);
    start(async () => {
      try {
        await reopenSubmission(submissionId);
        router.refresh();
      } catch (e: any) {
        setError(e.message);
      }
    });
  }

  const graded = status === "graded";

  return (
    <div className="mt-4 rounded-lg border border-white/5 bg-black/30 p-4">
      <div className="text-xs text-white/40">
        Submitted {submittedAt ? new Date(submittedAt).toLocaleString() : "—"}
      </div>

      {content && (
        <div className="mt-3 whitespace-pre-wrap break-words [overflow-wrap:anywhere] rounded-lg bg-zinc-950/60 p-3 text-sm text-white/80">
          {content}
        </div>
      )}

      {links.length > 0 && (
        <div className="mt-3">
          <div className="text-[10px] uppercase tracking-wider text-white/40">
            Links
          </div>
          <ul className="mt-1.5 space-y-1">
            {links.map((l, i) => (
              <li key={i}>
                <a
                  href={l.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 text-sm text-spark hover:underline"
                >
                  <ExternalLink className="h-3 w-3" />
                  {l.title || l.url}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}

      {files.length > 0 && (
        <div className="mt-3">
          <div className="text-[10px] uppercase tracking-wider text-white/40">
            Files
          </div>
          <ul className="mt-1.5 space-y-1">
            {files.map((f, i) => (
              <li key={i}>
                {f.url ? (
                  <a
                    href={f.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 text-sm text-spark hover:underline"
                  >
                    <FileText className="h-3.5 w-3.5" />
                    {f.name}
                  </a>
                ) : (
                  <span className="inline-flex items-center gap-1.5 text-sm text-white/40">
                    <FileText className="h-3.5 w-3.5" />
                    {f.name}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-5 grid gap-3 md:grid-cols-3">
        <div>
          <Label>Grade</Label>
          <Input
            value={grade}
            onChange={(e) => setGrade(e.target.value)}
            placeholder="A / 95 / Pass"
          />
        </div>
        <div className="md:col-span-2">
          <Label>Feedback</Label>
          <Textarea
            rows={2}
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            placeholder="What went well, what to improve…"
          />
        </div>
      </div>
      <FieldError>{error}</FieldError>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button onClick={save} disabled={pending} size="sm">
          {pending ? "Saving…" : graded ? "Update grade" : "Save grade"}
        </Button>
        {graded && (
          <Button
            variant="ghost"
            size="sm"
            onClick={reopen}
            disabled={pending}
          >
            Re-open for resubmission
          </Button>
        )}
      </div>
    </div>
  );
}
