import { FileText, Download } from "lucide-react";
import {
  HTTP_URL_RE,
  isUploadAnswer,
  isImageFile,
  uploadPathOf,
  type ChallengeAnswerValue,
  type ChallengeQuestion,
  type TeamMember,
  type UploadedFile,
} from "@/lib/challenges-shared";

/**
 * Every storage path an answer set references, so the caller can mint signed
 * URLs in one batch before rendering <AnswerList>.
 */
export function uploadPathsIn(
  questions: ChallengeQuestion[],
  answers: Record<string, ChallengeAnswerValue>,
): string[] {
  const out: string[] = [];
  for (const q of questions) {
    const v = answers[q.id];
    if (isUploadAnswer(v)) out.push(uploadPathOf(v));
    if (q.type === "file" && Array.isArray(v)) {
      for (const f of v as UploadedFile[]) if (f?.path) out.push(f.path);
    }
  }
  return out;
}

function fmtBytes(n: number) {
  if (!n) return "";
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Read-only rendering of a submission — the admin review page and the
 * entrant's own "view submission" after the deadline. `signed` maps storage
 * path → a short-lived URL minted by the server page. Server-safe.
 */
export function AnswerList({
  questions,
  answers,
  signed,
}: {
  questions: ChallengeQuestion[];
  answers: Record<string, ChallengeAnswerValue>;
  signed: Record<string, string>;
}) {
  if (questions.length === 0) {
    return <p className="text-sm text-ink-faint">No questions were recorded.</p>;
  }
  return (
    <dl className="space-y-6">
      {questions.map((q) =>
        q.type === "section" ? (
          <div key={q.id} className="border-b border-line pb-1 pt-2">
            <p className="font-mono text-[12px] font-semibold uppercase tracking-[0.16em] text-phosphor-ink">
              {q.label}
            </p>
          </div>
        ) : (
          <div key={q.id}>
            <dt className="text-[12px] font-medium uppercase tracking-wider text-ink-faint">
              {q.label}
            </dt>
            <dd className="mt-1.5 text-sm text-ink">
              <AnswerValue q={q} v={answers[q.id]} signed={signed} />
            </dd>
          </div>
        ),
      )}
    </dl>
  );
}

function Empty() {
  return <span className="text-ink-faint">—</span>;
}

function AnswerValue({
  q,
  v,
  signed,
}: {
  q: ChallengeQuestion;
  v: ChallengeAnswerValue | undefined;
  signed: Record<string, string>;
}) {
  if (v == null || v === "" || (Array.isArray(v) && v.length === 0)) {
    return <Empty />;
  }

  if (isUploadAnswer(v)) {
    const url = signed[uploadPathOf(v)];
    return url ? (
      <div className="space-y-2">
        <video
          controls
          preload="metadata"
          src={url}
          className="w-full max-w-lg rounded-lg border border-line bg-black"
        />
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-block text-xs text-phosphor-ink underline decoration-phosphor-ink/30 underline-offset-2"
        >
          Open / download video
        </a>
      </div>
    ) : (
      <span className="text-ink-faint">Uploaded video (reload to refresh the link)</span>
    );
  }

  switch (q.type) {
    case "checkbox":
      return <span>{v === true ? "✓ Yes" : "No"}</span>;
    case "scale":
      return (
        <span className="font-mono">
          {String(v)} <span className="text-ink-faint">/ {q.scaleMax}</span>
        </span>
      );
    case "multi_select":
      return (
        <div className="flex flex-wrap gap-1.5">
          {(v as string[]).map((o) => (
            <span key={o} className="rounded-full border border-line px-2.5 py-0.5 text-[13px]">
              {o}
            </span>
          ))}
        </div>
      );
    case "team":
      return (
        <ul className="space-y-1">
          {(v as TeamMember[]).map((m, i) => (
            <li key={i}>
              {m.name || <span className="text-ink-faint">(no name)</span>}
              {m.email && (
                <a href={`mailto:${m.email}`} className="ml-2 text-ink-faint hover:underline">
                  {m.email}
                </a>
              )}
            </li>
          ))}
        </ul>
      );
    case "file": {
      const files = v as UploadedFile[];
      const images = files.filter((f) => isImageFile(f) && signed[f.path]);
      const others = files.filter((f) => !(isImageFile(f) && signed[f.path]));
      return (
        <div className="space-y-3">
          {images.length > 0 && (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {images.map((f) => (
                <a
                  key={f.path}
                  href={signed[f.path]}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block overflow-hidden rounded-lg border border-line bg-wash"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element -- short-lived signed URL */}
                  <img src={signed[f.path]} alt={f.name} className="aspect-video w-full object-cover" />
                </a>
              ))}
            </div>
          )}
          {others.map((f) => (
            <a
              key={f.path}
              href={signed[f.path] ?? "#"}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 rounded-md border border-line px-3 py-2 hover:bg-wash"
            >
              <FileText className="h-4 w-4 text-ink-faint" />
              <span className="min-w-0 flex-1 truncate">{f.name}</span>
              <span className="text-xs text-ink-faint">{fmtBytes(f.size)}</span>
              <Download className="h-3.5 w-3.5 text-ink-faint" />
            </a>
          ))}
        </div>
      );
    }
    default: {
      const s = String(v);
      if ((q.type === "url" || q.type === "video") && HTTP_URL_RE.test(s)) {
        return (
          <a
            href={s}
            target="_blank"
            rel="noopener noreferrer"
            className="break-all text-phosphor-ink underline decoration-phosphor-ink/30 underline-offset-2 hover:decoration-phosphor-ink"
          >
            {s}
          </a>
        );
      }
      return <span className="whitespace-pre-line">{s}</span>;
    }
  }
}
