"use client";
import { useRef, useState, useTransition } from "react";
import { Upload, CheckCircle2, X } from "lucide-react";
import { Button, ButtonLink } from "@/components/ui/button";
import { Input, Textarea, Label, FieldError } from "@/components/ui/input";
import {
  HTTP_URL_RE,
  CHALLENGE_UPLOAD_PREFIX,
  CHALLENGE_EXTRA_VIDEO_KEY,
  isUploadAnswer,
  type Challenge,
} from "@/lib/challenges-shared";
import { submitChallengeApplication, getChallengeUploadToken } from "./actions";

/** Applicant video uploads are capped client-side; the bucket enforces its
 *  own limit too (see migration 0047). 200 MB comfortably fits a short demo. */
const MAX_VIDEO_BYTES = 200 * 1024 * 1024;

/** The standalone "Demo video" field shown on every challenge form, regardless
 *  of the admin-authored questions. It reuses the `video` machinery via the
 *  reserved answer key. */
const EXTRA_VIDEO_Q: Challenge["questions"][number] = {
  id: CHALLENGE_EXTRA_VIDEO_KEY,
  type: "video",
  label: "Demo video",
  help: "Optional — paste a link or upload an MP4 showing your project.",
  placeholder: "https://www.loom.com/share/…",
  required: false,
  options: [],
};

function isMp4(file: File): boolean {
  return (
    file.type === "video/mp4" || file.name.toLowerCase().endsWith(".mp4")
  );
}

export function ChallengeForm({
  challenge,
  refCode,
}: {
  challenge: Pick<Challenge, "id" | "slug" | "title" | "questions">;
  refCode?: string | null;
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | undefined>();
  const [submitted, setSubmitted] = useState(false);
  const [pending, start] = useTransition();
  // Video-upload UI state, keyed by question id. `uploadedNames` holds the
  // friendly filename for display (the answer itself stores `upload:<path>`).
  const [uploadingId, setUploadingId] = useState<string | null>(null);
  const [uploadedNames, setUploadedNames] = useState<Record<string, string>>(
    {},
  );

  function set(id: string, value: string) {
    setAnswers((a) => ({ ...a, [id]: value }));
    setFieldErrors((e) => (e[id] ? { ...e, [id]: "" } : e));
  }

  /** Handle a picked/dropped video file for a `video` question. */
  async function uploadVideo(q: Challenge["questions"][number], file: File) {
    if (!isMp4(file)) {
      setFieldErrors((e) => ({ ...e, [q.id]: "Please choose an .mp4 file." }));
      return;
    }
    if (file.size > MAX_VIDEO_BYTES) {
      setFieldErrors((e) => ({
        ...e,
        [q.id]: "That video is over 200 MB — please compress it or paste a link.",
      }));
      return;
    }
    setFieldErrors((e) => (e[q.id] ? { ...e, [q.id]: "" } : e));
    setUploadingId(q.id);
    try {
      const tok = await getChallengeUploadToken({
        slug: challenge.slug,
        filename: file.name,
      });
      if (!tok.ok || !tok.path || !tok.token || !tok.bucket) {
        throw new Error(tok.error ?? "Couldn't start the upload.");
      }
      // Deferred import keeps supabase-js out of the form's chunk; only an
      // applicant who actually uploads a video (vs pasting a link) pays for it.
      const { createClient } = await import("@/lib/supabase/client");
      const supabase = createClient();
      const up = await supabase.storage
        .from(tok.bucket)
        .uploadToSignedUrl(tok.path, tok.token, file);
      if (up.error) throw up.error;
      // Uploading and pasting a link are mutually exclusive — the upload wins.
      set(q.id, `${CHALLENGE_UPLOAD_PREFIX}${tok.path}`);
      setUploadedNames((n) => ({ ...n, [q.id]: file.name }));
    } catch (e: any) {
      setFieldErrors((errs) => ({
        ...errs,
        [q.id]: e?.message ?? "Upload failed — try again or paste a link.",
      }));
    } finally {
      setUploadingId(null);
    }
  }

  /** Clear an uploaded video so the applicant can re-upload or paste a link. */
  function clearUpload(id: string) {
    set(id, "");
    setUploadedNames((n) => {
      const { [id]: _drop, ...rest } = n;
      return rest;
    });
  }

  function validate(): boolean {
    const errs: Record<string, string> = {};
    for (const q of challenge.questions) {
      const v = (answers[q.id] ?? "").trim();
      if (q.required && !v) {
        errs[q.id] = "Required";
        continue;
      }
      // A `video` answer may be an uploaded file (`upload:…`) — only run the
      // URL check when the applicant pasted a link instead.
      if (
        (q.type === "url" || q.type === "video") &&
        v &&
        !isUploadAnswer(v) &&
        !HTTP_URL_RE.test(v)
      ) {
        errs[q.id] = "Must be a full URL starting with http:// or https://";
      }
    }
    // The standalone demo video is optional; if a link was pasted (not an
    // upload), it still has to be a real URL.
    const ev = (answers[CHALLENGE_EXTRA_VIDEO_KEY] ?? "").trim();
    if (ev && !isUploadAnswer(ev) && !HTTP_URL_RE.test(ev)) {
      errs[CHALLENGE_EXTRA_VIDEO_KEY] =
        "Must be a full URL starting with http:// or https://";
    }
    setFieldErrors(errs);
    return Object.keys(errs).length === 0;
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(undefined);
    if (!validate()) return;
    start(async () => {
      const fd = new FormData();
      fd.set("slug", challenge.slug);
      if (refCode) fd.set("referral_code", refCode);
      for (const q of challenge.questions) {
        fd.set(`q_${q.id}`, answers[q.id] ?? "");
      }
      fd.set("extra_video", answers[CHALLENGE_EXTRA_VIDEO_KEY] ?? "");
      const res = await submitChallengeApplication(null, fd);
      if (res.ok) {
        setSubmitted(true);
        return;
      }
      if (res.fieldErrors) setFieldErrors(res.fieldErrors);
      setFormError(res.error);
    });
  }

  if (submitted) {
    return (
      <div className="rounded-2xl border border-phosphor/30 bg-phosphor/5 p-6">
        <p className="font-mono text-[11px] font-semibold uppercase tracking-[0.22em] text-phosphor-ink">
          Application in
        </p>
        <h2 className="mt-2 font-display text-2xl font-bold tracking-[-0.02em] text-ink">
          You&apos;re entered.
        </h2>
        <p className="mt-2 text-sm text-ink-soft">
          We review funding decisions weekly and will email you either way.
          Thanks for building with us.
        </p>
        <div className="mt-5 flex flex-wrap gap-3">
          <ButtonLink href="/dashboard" variant="secondary">
            Go to dashboard
          </ButtonLink>
          <ButtonLink href="/challenges" variant="ghost">
            See other challenges
          </ButtonLink>
        </div>
      </div>
    );
  }

  return (
    <form
      onSubmit={onSubmit}
      className="rounded-2xl border border-line bg-wash p-5 sm:p-6 md:p-8"
    >
      <div className="space-y-6">
        {challenge.questions.map((q) => {
          const err = fieldErrors[q.id] || undefined;
          const inputId = `q_${q.id}`;
          return (
            <div key={q.id}>
              <Label htmlFor={inputId} required={q.required}>
                {q.label}
                {q.required && <span aria-hidden className="text-phosphor-ink"> *</span>}
              </Label>
              {q.help && (
                <p className="mb-1.5 text-xs text-ink-soft">{q.help}</p>
              )}

              {q.type === "long_text" ? (
                <Textarea
                  id={inputId}
                  rows={5}
                  value={answers[q.id] ?? ""}
                  onChange={(e) => set(q.id, e.target.value)}
                  placeholder={q.placeholder}
                  error={err}
                />
              ) : q.type === "video" || q.type === "url" ? (
                <VideoField
                  inputId={inputId}
                  value={answers[q.id] ?? ""}
                  uploadedName={uploadedNames[q.id]}
                  uploading={uploadingId === q.id}
                  disabled={uploadingId !== null && uploadingId !== q.id}
                  placeholder={q.placeholder}
                  error={err}
                  onUrlChange={(v) => set(q.id, v)}
                  onPickFile={(f) => uploadVideo(q, f)}
                  onClear={() => clearUpload(q.id)}
                />
              ) : q.type === "select" ? (
                <div
                  role="radiogroup"
                  aria-label={q.label}
                  className="flex flex-wrap gap-2"
                >
                  {q.options.map((opt) => {
                    const active = (answers[q.id] ?? "") === opt;
                    return (
                      <label
                        key={opt}
                        className={`press inline-flex cursor-pointer items-center rounded-md border px-3.5 py-2 text-sm transition ${
                          active
                            ? "border-phosphor bg-phosphor/10 text-phosphor-ink"
                            : "border-line text-ink-soft hover:border-ink/30"
                        }`}
                      >
                        <input
                          type="radio"
                          name={inputId}
                          value={opt}
                          checked={active}
                          onChange={() => set(q.id, opt)}
                          className="sr-only"
                        />
                        {opt}
                      </label>
                    );
                  })}
                </div>
              ) : (
                // short_text (url/video are handled by VideoField above).
                <Input
                  id={inputId}
                  type="text"
                  value={answers[q.id] ?? ""}
                  onChange={(e) => set(q.id, e.target.value)}
                  placeholder={q.placeholder}
                  error={err}
                />
              )}

              <FieldError id={`${inputId}-error`}>{err}</FieldError>
            </div>
          );
        })}

        {challenge.questions.length === 0 && (
          <p className="text-sm text-ink-soft">
            This challenge doesn&apos;t have any questions yet — check back
            shortly.
          </p>
        )}

        {/* Standalone demo-video field — always offered, independent of the
            admin-authored questions above. */}
        <div>
          <Label htmlFor={`q_${EXTRA_VIDEO_Q.id}`}>{EXTRA_VIDEO_Q.label}</Label>
          {EXTRA_VIDEO_Q.help && (
            <p className="mb-1.5 text-xs text-ink-soft">{EXTRA_VIDEO_Q.help}</p>
          )}
          <VideoField
            inputId={`q_${EXTRA_VIDEO_Q.id}`}
            value={answers[EXTRA_VIDEO_Q.id] ?? ""}
            uploadedName={uploadedNames[EXTRA_VIDEO_Q.id]}
            uploading={uploadingId === EXTRA_VIDEO_Q.id}
            disabled={uploadingId !== null && uploadingId !== EXTRA_VIDEO_Q.id}
            placeholder={EXTRA_VIDEO_Q.placeholder}
            error={fieldErrors[EXTRA_VIDEO_Q.id] || undefined}
            onUrlChange={(v) => set(EXTRA_VIDEO_Q.id, v)}
            onPickFile={(f) => uploadVideo(EXTRA_VIDEO_Q, f)}
            onClear={() => clearUpload(EXTRA_VIDEO_Q.id)}
          />
          <FieldError id={`q_${EXTRA_VIDEO_Q.id}-error`}>
            {fieldErrors[EXTRA_VIDEO_Q.id] || undefined}
          </FieldError>
        </div>
      </div>

      {formError && (
        <p className="mt-6 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300">
          {formError}
        </p>
      )}

      <div className="mt-8">
        <Button
          type="submit"
          size="lg"
          disabled={
            pending ||
            uploadingId !== null ||
            challenge.questions.length === 0
          }
        >
          {pending
            ? "Submitting…"
            : uploadingId !== null
              ? "Uploading video…"
              : "Submit application"}
        </Button>
        <p className="mt-3 text-xs text-ink-faint">
          Free to apply. We review weekly and fund the ones we love.
        </p>
      </div>
    </form>
  );
}

/**
 * A `video` question: keep the paste-a-link input AND offer a drag-and-drop /
 * browse box for an .mp4. Uploading and pasting a link are mutually exclusive
 * — whichever the applicant does last is the answer.
 */
function VideoField({
  inputId,
  value,
  uploadedName,
  uploading,
  disabled,
  placeholder,
  error,
  onUrlChange,
  onPickFile,
  onClear,
}: {
  inputId: string;
  value: string;
  uploadedName?: string;
  uploading: boolean;
  disabled: boolean;
  placeholder: string;
  error?: string;
  onUrlChange: (v: string) => void;
  onPickFile: (f: File) => void;
  onClear: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const uploaded = isUploadAnswer(value);

  function handleFiles(list: FileList | null) {
    const f = list?.[0];
    if (f) onPickFile(f);
  }

  return (
    <div className="space-y-3">
      {/* The paste-a-link box — always present, never replaced. When a file is
          uploaded the answer holds the upload, so show the link field empty
          rather than the internal `upload:` value. */}
      <Input
        id={inputId}
        type="url"
        inputMode="url"
        value={uploaded ? "" : value}
        onChange={(e) => onUrlChange(e.target.value)}
        placeholder={placeholder || "https://www.loom.com/share/…"}
        error={error}
      />

      <div className="flex items-center gap-3 text-xs text-ink-faint">
        <span className="h-px flex-1 bg-line" />
        or upload an MP4
        <span className="h-px flex-1 bg-line" />
      </div>

      {/* The separate file-upload box — drag-and-drop + Browse. */}
      {uploaded ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-phosphor/40 bg-phosphor/5 px-3.5 py-3">
          <div className="flex items-center gap-2 text-sm text-ink">
            <CheckCircle2 className="h-4 w-4 text-phosphor-ink" />
            <span className="font-medium">Video uploaded</span>
            {uploadedName && (
              <span className="text-ink-faint">· {uploadedName}</span>
            )}
          </div>
          <button
            type="button"
            onClick={onClear}
            className="inline-flex items-center gap-1 text-xs font-medium text-ink-soft hover:text-ink"
          >
            <X className="h-3.5 w-3.5" /> Remove
          </button>
        </div>
      ) : (
        <div
          role="button"
          tabIndex={0}
          aria-label="Upload an MP4 video"
          onClick={() => !disabled && !uploading && fileRef.current?.click()}
          onKeyDown={(e) => {
            if ((e.key === "Enter" || e.key === " ") && !disabled && !uploading) {
              e.preventDefault();
              fileRef.current?.click();
            }
          }}
          onDragOver={(e) => {
            e.preventDefault();
            if (!disabled && !uploading) setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            if (!disabled && !uploading) handleFiles(e.dataTransfer.files);
          }}
          className={`press flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-4 py-8 text-center transition ${
            dragging
              ? "border-phosphor bg-phosphor/10"
              : "border-line bg-wash hover:border-ink/30"
          } ${disabled || uploading ? "cursor-not-allowed opacity-60" : ""}`}
        >
          <Upload className="h-5 w-5 text-ink-soft" />
          <div className="text-sm text-ink">
            {uploading ? (
              "Uploading…"
            ) : (
              <>
                <span className="font-medium text-phosphor-ink">
                  Browse for an MP4
                </span>{" "}
                or drop it here
              </>
            )}
          </div>
          <div className="text-xs text-ink-faint">MP4 up to 200 MB</div>
          <input
            ref={fileRef}
            type="file"
            accept="video/mp4,.mp4"
            className="hidden"
            disabled={disabled || uploading}
            onChange={(e) => {
              handleFiles(e.target.files);
              e.target.value = "";
            }}
          />
        </div>
      )}
    </div>
  );
}
