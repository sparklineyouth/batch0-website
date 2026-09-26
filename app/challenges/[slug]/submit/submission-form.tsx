"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  Check,
  CheckCircle2,
  CloudOff,
  FileText,
  ImageIcon,
  Loader2,
  Lock,
  Plus,
  RefreshCw,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { Button, ButtonLink } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { Countdown } from "@/components/challenges/time";
import { LocalTime } from "@/components/ui/local-time";
import { ShareLink } from "@/components/challenges/share-link";
import { challengeRefKey, readChallengeRef } from "@/lib/challenge-ref";
import {
  acceptFor,
  answerIsEmpty,
  CHALLENGE_UPLOAD_PREFIX,
  extensionsFor,
  fileExtension,
  FILE_KIND_LABELS,
  HTTP_URL_RE,
  isChallengeOpen,
  isImageFile,
  isInputQuestion,
  isUploadAnswer,
  LONG_TEXT_MAX,
  MAX_FILE_BYTES,
  MAX_VIDEO_BYTES,
  requiredProgress,
  SHORT_TEXT_MAX,
  uploadPathOf,
  validateAnswers,
  VIDEO_EXTENSIONS,
  type Challenge,
  type ChallengeQuestion,
  type SubmissionStatus,
  type TeamMember,
  type UploadedFile,
} from "@/lib/challenges-shared";
import type { ReferralFriend } from "@/lib/challenges";
import {
  getChallengeUploadToken,
  refreshReferralProgress,
  saveChallengeDraft,
  submitChallengeEntry,
} from "../actions";

type FormChallenge = Pick<
  Challenge,
  | "slug"
  | "title"
  | "questions"
  | "status"
  | "opensAt"
  | "closesAt"
  | "allowEdits"
  | "referralsRequired"
> & { kindLabel: string; kind: Challenge["kind"] };

type Referral = {
  required: number;
  count: number;
  friends: ReferralFriend[];
  link: string | null;
};

type Answers = Record<string, any>;
type SaveState = "idle" | "dirty" | "saving" | "saved" | "error";

function readRef(slug: string): string | null {
  try {
    const u = new URL(window.location.href).searchParams.get("ref");
    return u || readChallengeRef(slug);
  } catch {
    return null;
  }
}

/** Name the service behind a link, so a pasted URL visibly "lands". */
function linkKind(url: string): string | null {
  try {
    const h = new URL(url).hostname.replace(/^www\./, "");
    const map: [RegExp, string][] = [
      [/(^|\.)youtube\.com$|^youtu\.be$/, "YouTube"],
      [/(^|\.)loom\.com$/, "Loom"],
      [/(^|\.)github\.com$/, "GitHub"],
      [/(^|\.)figma\.com$/, "Figma"],
      [/(^|\.)drive\.google\.com$|(^|\.)docs\.google\.com$/, "Google Drive"],
      [/(^|\.)replit\.com$|\.repl\.co$/, "Replit"],
      [/\.vercel\.app$/, "Vercel"],
      [/\.netlify\.app$/, "Netlify"],
      [/(^|\.)devpost\.com$/, "Devpost"],
      [/(^|\.)vimeo\.com$/, "Vimeo"],
      [/(^|\.)canva\.com$/, "Canva"],
      [/(^|\.)notion\.(so|site)$/, "Notion"],
      [/(^|\.)tiktok\.com$/, "TikTok"],
      [/(^|\.)instagram\.com$/, "Instagram"],
    ];
    for (const [re, name] of map) if (re.test(h)) return name;
    return h;
  } catch {
    return null;
  }
}

/** "example.com/x" → "https://example.com/x" on blur. */
function normalizeUrl(v: string): string {
  const t = v.trim();
  if (!t || HTTP_URL_RE.test(t) || t.startsWith(CHALLENGE_UPLOAD_PREFIX)) return t;
  if (/^[^\s]+\.[^\s]{2,}/.test(t) && !t.includes(" ")) return `https://${t}`;
  return t;
}

function fmtBytes(n: number) {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function ago(iso: string | null): string {
  if (!iso) return "";
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function SubmissionForm({
  challenge,
  cover,
  initialAnswers,
  initialStatus,
  initialSubmittedAt,
  initialVersion,
  initialPreviews,
  referral: initialReferral,
  preview,
}: {
  challenge: FormChallenge;
  cover: React.ReactNode;
  initialAnswers: Answers;
  initialStatus: SubmissionStatus | null;
  initialSubmittedAt: string | null;
  /** The saved row's answers_version: the optimistic-concurrency token. */
  initialVersion: number | null;
  initialPreviews: Record<string, string>;
  referral: Referral | null;
  preview: boolean;
}) {
  const router = useRouter();
  const questions = challenge.questions;
  const isGiveaway = challenge.kind === "giveaway";
  const [answers, setAnswers] = useState<Answers>(initialAnswers);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [status, setStatus] = useState<SubmissionStatus | null>(initialStatus);
  const [submittedAt, setSubmittedAt] = useState<string | null>(initialSubmittedAt);
  const [saveState, setSaveState] = useState<SaveState>(
    initialStatus ? "saved" : "idle",
  );
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState<null | "submitted" | "updated">(null);
  const [referral, setReferral] = useState<Referral | null>(initialReferral);
  const [previews, setPreviews] = useState<Record<string, string>>(initialPreviews);
  const [uploading, setUploading] = useState<Record<string, number>>({});
  const [conflict, setConflict] = useState<null | { answers: Answers; version: number }>(null);
  const [signedOut, setSignedOut] = useState(false);
  const [closedNow, setClosedNow] = useState(false);

  // A live clock, not a one-shot: a tab left open across kickoff or the
  // deadline has to flip "Opens soon" → "Submit" (and back) on its own. A
  // timer aimed at the exact open time makes the switch land on the second.
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 15_000);
    const opensIn = challenge.opensAt ? new Date(challenge.opensAt).getTime() - Date.now() : -1;
    const kick = opensIn > 0 && opensIn < 2 ** 31 - 1 ? setTimeout(() => setNow(Date.now()), opensIn + 250) : null;
    return () => {
      clearInterval(t);
      if (kick) clearTimeout(kick);
    };
  }, [challenge.opensAt]);

  const isSubmitted = !!status && status !== "draft";
  // Autosave only a draft. A submitted entry is edited deliberately and saved
  // with "Save changes", which re-validates everything.
  const autosave = !preview && !isSubmitted && !conflict && !signedOut && !closedNow;
  const open =
    !closedNow && (now == null ? challenge.status === "active" : isChallengeOpen(challenge, now));
  const opensLater =
    now != null && !!challenge.opensAt && new Date(challenge.opensAt).getTime() > now;
  // Only a still-'submitted' entry can be edited; a reviewed one is locked.
  const canEdit = preview || !isSubmitted || (challenge.allowEdits && status === "submitted" && open);
  const gateLocked =
    !preview && !isSubmitted && !!referral && referral.count < referral.required;

  // --- autosave --------------------------------------------------------------
  const answersRef = useRef(answers);
  answersRef.current = answers;
  const versionRef = useRef<number | null>(initialVersion);
  const dirty = useRef(false);
  const inFlight = useRef<Promise<void> | null>(null);
  const again = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryDelay = useRef(4000);
  const mounted = useRef(true);
  const submittingRef = useRef(false);
  // Timers must call the CURRENT flush, not the one captured when they were
  // scheduled: `autosave` flips (conflict resolved, signed back in) between
  // scheduling and firing, and a stale closure would quietly do nothing.
  const flushRef = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timer.current) clearTimeout(timer.current);
      // Leaving the page (Back, swipe, a link) must not drop the last second
      // of typing that was waiting on the debounce.
      if (dirty.current) void flushRef.current();
    };
  }, []);

  const schedule = useCallback((ms: number, fn: () => void) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(fn, ms);
  }, []);

  const flush = useCallback(async (): Promise<void> => {
    if (!autosave || submittingRef.current) return;
    if (inFlight.current) {
      again.current = true;
      return inFlight.current;
    }
    if (!dirty.current) return;
    dirty.current = false;
    setSaveState("saving");
    const run = (async () => {
      const res: any = await saveChallengeDraft({
        slug: challenge.slug,
        answers: answersRef.current,
        version: versionRef.current,
        refCode: readRef(challenge.slug),
      }).catch(() => ({ ok: false, transient: true, error: "You're offline — we'll keep trying." }));
      if (res.ok) {
        retryDelay.current = 4000;
        if (res.version) versionRef.current = res.version;
        setSaveState(dirty.current ? "dirty" : "saved");
        setSavedAt(res.savedAt ?? new Date().toISOString());
        setStatus((s) => s ?? "draft");
        setFormError(null);
        return;
      }
      // Anything unsaved stays pending, whatever went wrong.
      dirty.current = true;
      if (res.alreadySubmitted) {
        // Submitted from another tab or device. Keep what was typed here;
        // "Save changes" can still apply it if edits are allowed.
        setStatus("submitted");
        setSaveState("dirty");
        setFormError(
          challenge.allowEdits
            ? "This entry was submitted from another tab or device. Press Save changes to keep the edits you just made here."
            : "This entry was already submitted from another tab or device, so these edits can't be saved.",
        );
      } else if (res.conflict) {
        setSaveState("error");
        if (res.latest) setConflict({ answers: res.latest.answers, version: res.latest.version });
      } else if (res.signIn) {
        setSaveState("error");
        setSignedOut(true);
      } else if (res.closed) {
        setSaveState("error");
        setClosedNow(true);
        setFormError("This challenge has closed, so changes can no longer be saved.");
      } else if (res.transient || res.retryable) {
        // Only transport hiccups and rate limits retry, with backoff.
        setSaveState("error");
        setFormError(res.error ?? "Couldn't save — retrying.");
        const d = retryDelay.current;
        retryDelay.current = Math.min(d * 2, 60_000);
        schedule(d, () => void flushRef.current());
      } else {
        setSaveState("error");
        setFormError(res.error ?? "Couldn't save.");
      }
    })();
    inFlight.current = run;
    try {
      await run;
    } finally {
      inFlight.current = null;
    }
    if (again.current) {
      again.current = false;
      schedule(800, () => void flushRef.current());
    }
  }, [autosave, challenge.allowEdits, challenge.slug, schedule]);
  flushRef.current = flush;

  const markDirty = useCallback(() => {
    if (preview) return;
    dirty.current = true;
    setSaveState("dirty");
    if (!autosave) return;
    schedule(1200, () => void flushRef.current());
  }, [autosave, preview, schedule]);

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "hidden") void flushRef.current();
      // Coming back from sharing the link: the count may have moved.
      else if (gateLocked) void refreshReferrals();
    };
    const onUnload = (e: BeforeUnloadEvent) => {
      if (dirty.current || Object.values(uploading).some((n) => n > 0)) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("beforeunload", onUnload);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("beforeunload", onUnload);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flush, uploading, gateLocked]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (autosave) void flushRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [autosave, flush]);

  /** Write through the ref first, so an upload that finishes after the page
   *  was left still reaches the next save instead of vanishing with state. */
  function write(id: string, value: any) {
    answersRef.current = { ...answersRef.current, [id]: value };
    if (mounted.current) setAnswers(answersRef.current);
  }

  function set(id: string, value: any) {
    write(id, value);
    setErrors((e) => (e[id] ? { ...e, [id]: "" } : e));
    setFormError(null);
    markDirty();
  }

  function resolveConflict(choice: "theirs" | "mine") {
    if (!conflict) return;
    versionRef.current = conflict.version;
    if (choice === "theirs") {
      answersRef.current = conflict.answers;
      setAnswers(conflict.answers);
      dirty.current = false;
      setSaveState("saved");
      setConflict(null);
      setFormError(null);
      return;
    }
    // Keep mine: retry against the latest version, which now matches.
    setConflict(null);
    setFormError(null);
    dirty.current = true;
    // Runs after this re-render, when flushRef holds the autosave-on flush.
    schedule(0, () => void flushRef.current());
  }

  // --- uploads ---------------------------------------------------------------
  async function uploadOne(q: ChallengeQuestion, file: File): Promise<UploadedFile | null> {
    const isVideo = q.type === "video";
    const allowed = isVideo ? VIDEO_EXTENSIONS : extensionsFor(q.fileKind);
    const ext = fileExtension(file.name);
    if (!allowed.includes(ext)) {
      setErrors((e) => ({
        ...e,
        [q.id]: `${file.name}: that type isn't accepted here.`,
      }));
      return null;
    }
    const cap = isVideo ? MAX_VIDEO_BYTES : MAX_FILE_BYTES;
    if (file.size > cap) {
      setErrors((e) => ({
        ...e,
        [q.id]: `${file.name} is over ${Math.round(cap / 1024 / 1024)} MB${isVideo ? " — compress it or paste a link instead" : ""}.`,
      }));
      return null;
    }
    setUploading((u) => ({ ...u, [q.id]: (u[q.id] ?? 0) + 1 }));
    try {
      const tok = await getChallengeUploadToken({
        slug: challenge.slug,
        questionId: q.id,
        filename: file.name,
        size: file.size,
      });
      if (!tok.ok || !tok.path || !tok.token || !tok.bucket) {
        throw new Error(tok.error ?? "Couldn't start the upload.");
      }
      // Deferred: only entrants who actually upload pay for supabase-js.
      const { createClient } = await import("@/lib/supabase/client");
      const up = await createClient()
        .storage.from(tok.bucket)
        .uploadToSignedUrl(tok.path, tok.token, file, {
          contentType: file.type || undefined,
        });
      if (up.error) throw up.error;
      if (isImageFile(file) && mounted.current) {
        const local = URL.createObjectURL(file);
        setPreviews((p) => ({ ...p, [tok.path!]: local }));
      }
      return { path: tok.path, name: file.name, size: file.size, type: file.type };
    } catch (e: any) {
      setErrors((errs) => ({
        ...errs,
        [q.id]: e?.message ?? "Upload failed — try again.",
      }));
      return null;
    } finally {
      setUploading((u) => ({ ...u, [q.id]: Math.max(0, (u[q.id] ?? 1) - 1) }));
    }
  }

  async function addFiles(q: ChallengeQuestion, list: FileList | File[]) {
    if (preview) return;
    const current: UploadedFile[] = Array.isArray(answersRef.current[q.id])
      ? answersRef.current[q.id]
      : [];
    const room = q.maxFiles - current.length;
    const files = Array.from(list);
    if (room <= 0) {
      setErrors((e) => ({ ...e, [q.id]: `Up to ${q.maxFiles} file${q.maxFiles === 1 ? "" : "s"} here — remove one first.` }));
      return;
    }
    if (files.length > room) {
      setErrors((e) => ({ ...e, [q.id]: `Only ${room} more fit — added the first ${room}.` }));
    } else {
      setErrors((e) => (e[q.id] ? { ...e, [q.id]: "" } : e));
    }
    const results = await Promise.all(files.slice(0, room).map((f) => uploadOne(q, f)));
    const ok = results.filter(Boolean) as UploadedFile[];
    if (!ok.length) return;
    const prev: UploadedFile[] = Array.isArray(answersRef.current[q.id]) ? answersRef.current[q.id] : [];
    write(q.id, [...prev, ...ok].slice(0, q.maxFiles));
    markDirty();
  }

  async function uploadVideo(q: ChallengeQuestion, file: File) {
    if (preview) return;
    const res = await uploadOne(q, file);
    if (res) set(q.id, `${CHALLENGE_UPLOAD_PREFIX}${res.path}`);
  }

  // --- submit ----------------------------------------------------------------
  function scrollTo(id: string) {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  async function refreshReferrals(): Promise<Referral | null> {
    const res = await refreshReferralProgress({ slug: challenge.slug }).catch(() => null);
    if (!res?.ok || !res.progress || !referral) return null;
    const fresh = { ...referral, ...res.progress };
    setReferral(fresh);
    return fresh;
  }

  async function submit() {
    setFormError(null);
    const { errors: errs } = validateAnswers(questions, answersRef.current, { mode: "submit" });
    if (preview) {
      setErrors(errs);
      setFormError(
        Object.keys(errs).length
          ? "Preview: these answers would be blocked."
          : "Preview: this would submit. (Nothing is saved in preview.)",
      );
      return;
    }
    if (Object.keys(errs).length) {
      setErrors(errs);
      const first = questions.find((q) => errs[q.id]);
      if (first) scrollTo(`q-${first.id}`);
      setFormError("A few answers need another look.");
      return;
    }
    setSubmitting(true);
    // The local count can be stale (a friend just signed up) — ask first.
    if (gateLocked) {
      const fresh = await refreshReferrals();
      if (fresh && fresh.count < fresh.required) {
        setSubmitting(false);
        scrollTo("referral-gate");
        const left = fresh.required - fresh.count;
        setFormError(`Refer ${left} more friend${left === 1 ? "" : "s"} to unlock submitting. Your answers are saved.`);
        return;
      }
    }
    // Let an autosave that's already running land first, so the version we
    // send is the one the server now holds — and keep any new one from
    // starting (or re-arming) while the submit is out.
    submittingRef.current = true;
    if (timer.current) clearTimeout(timer.current);
    if (inFlight.current) await inFlight.current.catch(() => null);
    if (timer.current) clearTimeout(timer.current);
    again.current = false;
    const res: any = await submitChallengeEntry({
      slug: challenge.slug,
      answers: answersRef.current,
      version: versionRef.current,
      refCode: readRef(challenge.slug),
    }).catch(() => ({ ok: false, error: "Network hiccup — try again." }));
    submittingRef.current = false;
    setSubmitting(false);
    if (!res.ok) {
      if (res.signIn) setSignedOut(true);
      if (res.conflict && res.latest) setConflict({ answers: res.latest.answers, version: res.latest.version });
      if (res.fieldErrors) {
        setErrors(res.fieldErrors);
        const first = questions.find((q) => res.fieldErrors[q.id]);
        if (first) scrollTo(`q-${first.id}`);
      }
      if (res.referral) {
        setReferral((r) => (r ? { ...r, ...res.referral } : r));
        scrollTo("referral-gate");
      }
      setFormError(res.error ?? "Couldn't submit.");
      // Whatever was typed in the last second still needs saving.
      if (dirty.current && autosave) schedule(0, () => void flushRef.current());
      return;
    }
    if (res.version) versionRef.current = res.version;
    dirty.current = false;
    setSaveState("saved");
    setSavedAt(new Date().toISOString());
    setStatus("submitted");
    if (!submittedAt) setSubmittedAt(new Date().toISOString());
    setDone(res.edited ? "updated" : "submitted");
    try {
      window.localStorage.removeItem(challengeRefKey(challenge.slug));
    } catch {}
    window.scrollTo({ top: 0, behavior: "smooth" });
    router.refresh();
  }

  const progress = useMemo(() => requiredProgress(questions, answers), [questions, answers]);
  const anyUploading = Object.values(uploading).some((n) => n > 0);
  const eventHref = `/challenges/${challenge.slug}`;
  const inputQuestions = questions.filter(isInputQuestion);

  if (done) {
    return (
      <div className="mx-auto max-w-xl px-5 py-16 text-center sm:px-6">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-phosphor text-on-phosphor">
          <Check className="h-7 w-7" />
        </div>
        <h1 className="mt-5 font-display text-5xl text-ink">
          {done === "updated" ? "Changes saved" : isGiveaway ? "You're entered!" : "You're submitted!"}
        </h1>
        <p className="mx-auto mt-3 max-w-md text-[15px] text-ink-soft">
          {done === "updated"
            ? "Your entry is updated. The version you have at the deadline is the one we judge."
            : challenge.allowEdits
              ? "Your entry for " + challenge.title + " is in. You can keep improving it until the deadline — we judge whatever's there when it closes."
              : "Your entry for " + challenge.title + " is in. Winners are announced on the event page."}
        </p>
        <div className="mt-7 flex flex-wrap justify-center gap-3">
          <ButtonLink href={eventHref} size="lg">
            Back to the event
          </ButtonLink>
          {challenge.allowEdits && (
            <Button variant="secondary" size="lg" onClick={() => setDone(null)}>
              Keep editing
            </Button>
          )}
        </div>
        {referral?.link && (
          <div className="mx-auto mt-10 max-w-md text-left">
            <p className="text-[13px] font-medium text-ink">Know someone who&apos;d be into this?</p>
            <div className="mt-2">
              <ShareLink url={referral.link} shareText={`I just entered a batch0 ${challenge.kindLabel.toLowerCase()} — join me`} />
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="pb-32">
      {/* Header */}
      <header className="sticky top-0 z-20 border-b border-line bg-paper/95 backdrop-blur supports-[backdrop-filter]:bg-paper/80">
        <div className="mx-auto flex max-w-2xl items-center gap-3 px-5 py-3 sm:px-6">
          <Link
            href={eventHref}
            aria-label="Back to event"
            onClick={(e) => {
              if (anyUploading && !window.confirm("An upload is still in progress. Leave anyway? It won't be attached.")) {
                e.preventDefault();
              } else if (dirty.current && autosave) {
                void flushRef.current();
              }
            }}
            className="rounded-md p-1 text-ink-soft hover:bg-wash hover:text-ink"
          >
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <div className="w-9 shrink-0">{cover}</div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[14px] font-semibold text-ink">{challenge.title}</p>
            <p className="truncate font-mono text-[11px] text-ink-faint">
              {challenge.closesAt ? (
                opensLater && challenge.opensAt ? (
                  <>Submissions open in <Countdown to={challenge.opensAt} ended="moments" /></>
                ) : (
                  <>Due in <Countdown to={challenge.closesAt} ended="closed" /></>
                )
              ) : (
                "No deadline"
              )}
            </p>
          </div>
          <SaveBadge state={saveState} savedAt={savedAt} autosave={autosave} preview={preview} />
        </div>
      </header>

      <div className="mx-auto max-w-2xl px-5 pt-8 sm:px-6">
        {preview && (
          <p className="mb-6 rounded-lg border border-dashed border-line bg-wash px-4 py-3 text-[13px] text-ink-soft">
            <strong className="text-ink">Preview mode.</strong> This is exactly what entrants see.
            Typing and uploads here aren&apos;t saved.
          </p>
        )}

        {conflict && (
          <div role="alert" className="mb-6 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-[14px] text-ink">
            <p className="font-medium">Newer answers were saved from another tab or device.</p>
            <p className="mt-0.5 text-[13px] text-ink-soft">Autosave is paused so nothing gets overwritten. Which version do you want?</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button size="sm" onClick={() => resolveConflict("theirs")}>Load the newer version</Button>
              <Button size="sm" variant="secondary" onClick={() => resolveConflict("mine")}>Keep what&apos;s on this screen</Button>
            </div>
          </div>
        )}
        {signedOut && (
          <div role="alert" className="mb-6 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-[14px] text-ink">
            You&apos;ve been signed out, so changes aren&apos;t saving.{" "}
            <a
              href={`/login?next=${encodeURIComponent(`/challenges/${challenge.slug}/submit`)}`}
              className="font-medium underline decoration-phosphor decoration-2 underline-offset-2"
            >
              Sign back in
            </a>{" "}
            — copy anything long first.
          </div>
        )}

        <p className="font-mono text-[11px] font-semibold uppercase tracking-[0.18em] text-phosphor-ink">
          {isSubmitted ? "Your entry" : isGiveaway ? "Enter the giveaway" : "Submit your project"}
        </p>
        <h1 className="mt-2 font-display text-[clamp(2rem,5vw,2.75rem)] leading-[1.05] text-ink">
          {isSubmitted
            ? canEdit
              ? "Edit your entry"
              : "Your entry"
            : isGiveaway
              ? "Enter to win"
              : "Show us what you built"}
        </h1>
        <p className="mt-2 text-[15px] text-ink-soft">
          {isSubmitted ? (
            <>
              Submitted{submittedAt ? <> <LocalTime value={submittedAt} mode="date" /></> : null}.
              {canEdit
                ? " Changes aren't live until you press Save changes."
                : status === "submitted"
                  ? ""
                  : " It's been reviewed, so it's locked."}
            </>
          ) : (
            "Everything autosaves as you go, so you can close this tab and come back on any device."
          )}
        </p>

        {referral && !isSubmitted && (
          <ReferralGate
            referral={referral}
            onRefresh={async () => {
              await refreshReferrals();
            }}
            kindLabel={challenge.kindLabel}
          />
        )}

        <div className="mt-8 space-y-7">
          {inputQuestions.length === 0 && (
            <p className="rounded-lg border border-line bg-wash p-5 text-sm text-ink-soft">
              The organisers haven&apos;t added questions yet — check back shortly.
            </p>
          )}
          {questions.map((q, i) => (
            <QuestionField
              key={q.id}
              q={q}
              index={inputQuestions.indexOf(q)}
              value={answers[q.id]}
              error={errors[q.id]}
              disabled={!canEdit}
              uploading={uploading[q.id] ?? 0}
              previews={previews}
              onChange={(v) => set(q.id, v)}
              onFiles={(files) => addFiles(q, files)}
              onVideo={(f) => uploadVideo(q, f)}
              first={i === 0}
            />
          ))}
        </div>
      </div>

      {/* Sticky action bar */}
      <div className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-paper/95 backdrop-blur supports-[backdrop-filter]:bg-paper/85">
        <div className="mx-auto max-w-2xl px-5 py-3 sm:px-6">
          {formError && (
            <p className="mb-2 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-[13px] text-red-700 dark:text-red-300" role="alert">
              {formError}
            </p>
          )}
          <div className="flex items-center gap-4">
            <div className="min-w-0 flex-1">
              {progress.total > 0 ? (
                <>
                  <div className="flex items-center justify-between font-mono text-[11px] text-ink-faint">
                    <span>
                      {progress.done}/{progress.total} required
                    </span>
                    {progress.done === progress.total && (
                      <span className="text-phosphor-ink">ready ✓</span>
                    )}
                  </div>
                  <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-wash">
                    <div
                      className="h-full rounded-full bg-phosphor transition-[width] duration-300"
                      style={{ width: `${(progress.done / progress.total) * 100}%` }}
                    />
                  </div>
                </>
              ) : (
                <span className="font-mono text-[11px] text-ink-faint">All questions optional</span>
              )}
            </div>
            {isSubmitted && !canEdit ? (
              <span className="inline-flex items-center gap-1.5 text-[13px] font-medium text-ink">
                <CheckCircle2 className="h-4 w-4 text-phosphor-ink" /> Submitted
              </span>
            ) : (
              <Button
                size="lg"
                onClick={submit}
                disabled={
                  submitting ||
                  anyUploading ||
                  inputQuestions.length === 0 ||
                  !!conflict ||
                  signedOut ||
                  (!open && !preview) ||
                  (isSubmitted && saveState !== "dirty" && !preview)
                }
              >
                {submitting ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" /> Submitting…
                  </>
                ) : anyUploading ? (
                  "Uploading…"
                ) : !open && opensLater && !preview ? (
                  "Opens soon"
                ) : isSubmitted ? (
                  saveState === "dirty" ? "Save changes" : "Saved"
                ) : gateLocked ? (
                  <>
                    <Lock className="h-4 w-4" /> Submit
                  </>
                ) : isGiveaway ? (
                  "Enter"
                ) : (
                  "Submit project"
                )}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function SaveBadge({
  state,
  savedAt,
  autosave,
  preview,
}: {
  state: SaveState;
  savedAt: string | null;
  autosave: boolean;
  preview: boolean;
}) {
  if (preview) {
    return <span className="shrink-0 rounded-full border border-dashed border-line px-2 py-0.5 font-mono text-[11px] text-ink-faint">preview</span>;
  }
  const base = "inline-flex shrink-0 items-center gap-1 font-mono text-[11px]";
  if (state === "saving") {
    return (
      <span className={`${base} text-ink-faint`}>
        <Loader2 className="h-3 w-3 animate-spin" /> Saving
      </span>
    );
  }
  if (state === "error") {
    return (
      <span className={`${base} text-red-600 dark:text-red-400`}>
        <CloudOff className="h-3 w-3" /> Not saved
      </span>
    );
  }
  if (state === "dirty") {
    return <span className={`${base} text-ink-faint`}>{autosave ? "Editing…" : "Unsaved changes"}</span>;
  }
  if (state === "saved") {
    return (
      <span className={`${base} text-ink-faint`}>
        <Check className="h-3 w-3 text-phosphor-ink" /> Saved{savedAt ? ` ${ago(savedAt)}` : ""}
      </span>
    );
  }
  return autosave ? <span className={`${base} text-ink-faint`}>Autosave on</span> : null;
}

function ReferralGate({
  referral,
  onRefresh,
  kindLabel,
}: {
  referral: Referral;
  onRefresh: () => Promise<void>;
  kindLabel: string;
}) {
  const [busy, setBusy] = useState(false);
  const done = referral.count >= referral.required;
  const pct = Math.min(100, (referral.count / Math.max(1, referral.required)) * 100);
  return (
    <section
      id="referral-gate"
      className={`mt-7 scroll-mt-24 rounded-xl border p-5 ${
        done ? "border-line bg-paper" : "border-phosphor/60 bg-phosphor/[0.07]"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span
            className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${
              done ? "bg-phosphor text-on-phosphor" : "border border-phosphor bg-paper text-phosphor-ink"
            }`}
          >
            {done ? <Check className="h-4 w-4" /> : <Lock className="h-4 w-4" />}
          </span>
          <div>
            <p className="font-semibold text-ink">
              {done
                ? "Referrals complete — you can submit"
                : `Refer ${referral.required} friend${referral.required === 1 ? "" : "s"} to unlock submitting`}
            </p>
            <p className="mt-0.5 text-[13px] leading-snug text-ink-soft">
              A friend counts once they create a batch0 account from your link and
              either register for this {kindLabel.toLowerCase()} or apply to a cohort.
              Keep working on your answers meanwhile — they&apos;re saved.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={async () => {
            setBusy(true);
            await onRefresh();
            setBusy(false);
          }}
          className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[12px] text-ink-soft hover:bg-wash hover:text-ink"
          aria-label="Refresh referral count"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`} /> Refresh
        </button>
      </div>

      <div className="mt-4 flex items-center gap-3">
        <div className="h-2 flex-1 overflow-hidden rounded-full bg-paper ring-1 ring-line">
          <div className="h-full rounded-full bg-phosphor transition-[width] duration-500" style={{ width: `${pct}%` }} />
        </div>
        <span className="font-mono text-[13px] font-semibold tabular-nums text-ink">
          {Math.min(referral.count, referral.required)}/{referral.required}
        </span>
      </div>

      {referral.link ? (
        <div className="mt-4">
          <ShareLink url={referral.link} shareText={`Join me in this batch0 ${kindLabel.toLowerCase()}`} />
        </div>
      ) : (
        <p className="mt-4 text-[13px] text-ink-faint">Your referral link isn&apos;t ready — refresh in a moment.</p>
      )}

      {referral.friends.length > 0 && (
        <ul className="mt-4 flex flex-wrap gap-2">
          {referral.friends.map((f, i) => (
            <li
              key={i}
              className="inline-flex items-center gap-1.5 rounded-full border border-line bg-paper px-2.5 py-1 text-[12px] text-ink"
            >
              <Check className="h-3 w-3 text-phosphor-ink" />
              {f.name}
              <span className="text-ink-faint">· {f.source === "applied" ? "applied" : "registered"}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// One question
// ---------------------------------------------------------------------------

function QuestionField({
  q,
  index,
  value,
  error,
  disabled,
  uploading,
  previews,
  onChange,
  onFiles,
  onVideo,
  first,
}: {
  q: ChallengeQuestion;
  index: number;
  value: any;
  error?: string;
  disabled: boolean;
  uploading: number;
  previews: Record<string, string>;
  onChange: (v: any) => void;
  onFiles: (files: FileList | File[]) => void;
  onVideo: (f: File) => void;
  first: boolean;
}) {
  const id = `q-${q.id}`;
  const inputId = `${id}-input`;
  const labelId = `${id}-label`;
  const helpId = q.help ? `${id}-help` : undefined;
  // Choice, scale, team and file questions are groups, not single inputs: a
  // <label htmlFor> has nothing to point at, so they're named by aria-labelledby.
  const isGroup = ["select", "multi_select", "scale", "team", "file"].includes(q.type) &&
    !(q.type === "select" && q.options.length > 8);

  if (q.type === "section") {
    return (
      <div className={`${first ? "" : "pt-4"}`}>
        <h2 className="border-b border-line pb-2 font-display text-2xl text-ink">{q.label}</h2>
        {q.help && <p className="mt-2 whitespace-pre-line text-[14px] text-ink-soft">{q.help}</p>}
      </div>
    );
  }

  const filled = !answerIsEmpty(q, value);
  const labelEl =
    q.type === "checkbox" ? null : (
      <div className="mb-2">
        {(() => {
          const inner = (
            <>
              <span
                className={`font-mono text-[11px] font-medium ${filled ? "text-phosphor-ink" : "text-ink-faint"}`}
                aria-hidden
              >
                {String(index + 1).padStart(2, "0")}
              </span>
              <span>
                {q.label}
                {q.required ? (
                  <>
                    <span className="text-phosphor-ink" aria-hidden> *</span>
                    <span className="sr-only"> (required)</span>
                  </>
                ) : (
                  <span className="ml-1.5 font-mono text-[11px] font-normal text-ink-faint">optional</span>
                )}
              </span>
            </>
          );
          const cls = "flex items-baseline gap-2 text-[15px] font-semibold text-ink";
          return isGroup ? (
            <p id={labelId} className={cls}>{inner}</p>
          ) : (
            <label id={labelId} htmlFor={inputId} className={cls}>{inner}</label>
          );
        })()}
        {q.help && <p id={helpId} className="mt-1 pl-7 whitespace-pre-line text-[13px] text-ink-soft">{q.help}</p>}
      </div>
    );

  let control: React.ReactNode = null;
  switch (q.type) {
    case "short_text":
    case "long_text": {
      const s = typeof value === "string" ? value : "";
      const cap = q.maxLength ?? (q.type === "long_text" ? LONG_TEXT_MAX : SHORT_TEXT_MAX);
      const showCount = q.maxLength != null || s.length > cap * 0.8;
      control = (
        <div>
          {q.type === "long_text" ? (
            <Textarea
              id={inputId}
              aria-required={q.required || undefined}
              aria-describedby={helpId}
              rows={6}
              value={s}
              disabled={disabled}
              onChange={(e) => onChange(e.target.value)}
              placeholder={q.placeholder}
              error={error}
              maxLength={cap}
              className="leading-relaxed"
            />
          ) : (
            <Input
              id={inputId}
              aria-required={q.required || undefined}
              aria-describedby={helpId}
              value={s}
              disabled={disabled}
              onChange={(e) => onChange(e.target.value)}
              placeholder={q.placeholder}
              error={error}
              maxLength={cap}
            />
          )}
          {showCount && (
            <p className={`mt-1 text-right font-mono text-[11px] ${s.length >= cap ? "text-red-600" : "text-ink-faint"}`}>
              {s.length.toLocaleString("en-US")}/{cap.toLocaleString("en-US")}
            </p>
          )}
        </div>
      );
      break;
    }
    case "url": {
      const s = typeof value === "string" && !isUploadAnswer(value) ? value : "";
      const kind = HTTP_URL_RE.test(s) ? linkKind(s) : null;
      control = (
        <div className="relative">
          <Input
            id={inputId}
            type="url"
            inputMode="url"
            value={s}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
            onBlur={(e) => {
              const n = normalizeUrl(e.target.value);
              if (n !== e.target.value) onChange(n);
            }}
            placeholder={q.placeholder || "https://…"}
            error={error}
            className={kind ? "pr-28" : ""}
          />
          {kind && (
            <span className="pointer-events-none absolute right-2 top-1/2 inline-flex max-w-[6.5rem] -translate-y-1/2 items-center gap-1 truncate rounded bg-wash px-1.5 py-0.5 font-mono text-[10px] text-ink-soft">
              <Check className="h-3 w-3 text-phosphor-ink" /> {kind}
            </span>
          )}
        </div>
      );
      break;
    }
    case "video":
      control = (
        <VideoControl
          inputId={inputId}
          value={typeof value === "string" ? value : ""}
          uploading={uploading > 0}
          disabled={disabled}
          placeholder={q.placeholder}
          error={error}
          onChange={onChange}
          onPick={onVideo}
        />
      );
      break;
    case "file":
      control = (
        <div role="group" aria-labelledby={labelId} aria-describedby={helpId}>
        <FileControl
          q={q}
          inputId={inputId}
          files={Array.isArray(value) ? value : []}
          uploading={uploading}
          disabled={disabled}
          previews={previews}
          onRemove={(path) =>
            onChange((Array.isArray(value) ? value : []).filter((f: UploadedFile) => f.path !== path))
          }
          onFiles={onFiles}
        />
        </div>
      );
      break;
    case "select": {
      const s = typeof value === "string" ? value : "";
      control =
        q.options.length > 8 ? (
          <select
            id={inputId}
            aria-required={q.required || undefined}
            value={s}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
            className="h-10 w-full rounded-md border border-line bg-paper px-3 text-base text-ink focus:border-phosphor focus:outline-none focus:ring-2 focus:ring-phosphor/30 md:text-sm"
          >
            <option value="">Choose one…</option>
            {q.options.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        ) : (
          <div role="radiogroup" aria-labelledby={labelId} aria-describedby={helpId} aria-required={q.required || undefined} className="flex flex-wrap gap-2">
            {q.options.map((o) => {
              const on = s === o;
              return (
                <button
                  key={o}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  disabled={disabled}
                  onClick={() => onChange(on && !q.required ? "" : o)}
                  className={`press rounded-md border px-3.5 py-2 text-sm ${
                    on ? "border-phosphor bg-phosphor/15 font-medium text-ink" : "border-line text-ink-soft hover:border-ink/30"
                  }`}
                >
                  {o}
                </button>
              );
            })}
          </div>
        );
      break;
    }
    case "multi_select": {
      const arr: string[] = Array.isArray(value) ? value : [];
      control = (
        <div role="group" aria-labelledby={labelId} aria-describedby={helpId} className="flex flex-wrap gap-2">
          {q.options.map((o) => {
            const on = arr.includes(o);
            return (
              <button
                key={o}
                type="button"
                aria-pressed={on}
                disabled={disabled}
                onClick={() => onChange(on ? arr.filter((x) => x !== o) : [...arr, o])}
                className={`press inline-flex items-center gap-1.5 rounded-md border px-3.5 py-2 text-sm ${
                  on ? "border-phosphor bg-phosphor/15 font-medium text-ink" : "border-line text-ink-soft hover:border-ink/30"
                }`}
              >
                <span className={`flex h-3.5 w-3.5 items-center justify-center rounded-sm border ${on ? "border-on-phosphor bg-phosphor" : "border-ink-faint"}`}>
                  {on && <Check className="h-2.5 w-2.5 text-on-phosphor" />}
                </span>
                {o}
              </button>
            );
          })}
        </div>
      );
      break;
    }
    case "number":
      control = (
        <Input
          id={inputId}
          aria-required={q.required || undefined}
          aria-describedby={helpId}
          type="number"
          inputMode="decimal"
          value={value == null ? "" : String(value)}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          placeholder={q.placeholder}
          error={error}
          className="max-w-[12rem]"
        />
      );
      break;
    case "scale": {
      const n = typeof value === "number" ? value : Number(value) || 0;
      control = (
        // inline-flex so the end labels span exactly the width of the buttons.
        <div className="inline-flex max-w-full flex-col">
          <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-labelledby={labelId} aria-describedby={helpId} aria-required={q.required || undefined}>
            {Array.from({ length: q.scaleMax }, (_, i) => i + 1).map((k) => (
              <button
                key={k}
                type="button"
                role="radio"
                aria-checked={n === k}
                disabled={disabled}
                onClick={() => onChange(n === k ? null : k)}
                className={`press h-10 min-w-10 rounded-md border px-2 font-mono text-sm ${
                  n === k ? "border-phosphor bg-phosphor font-semibold text-on-phosphor" : "border-line text-ink-soft hover:border-ink/30"
                }`}
              >
                {k}
              </button>
            ))}
          </div>
          {(q.scaleMinLabel || q.scaleMaxLabel) && (
            <div className="mt-1.5 flex justify-between gap-4 text-[12px] text-ink-faint">
              <span>{q.scaleMinLabel}</span>
              <span>{q.scaleMaxLabel}</span>
            </div>
          )}
        </div>
      );
      break;
    }
    case "team":
      control = (
        <div role="group" aria-labelledby={labelId} aria-describedby={helpId}>
        <TeamControl
          members={Array.isArray(value) ? value : []}
          max={q.maxTeam}
          disabled={disabled}
          onChange={onChange}
        />
        </div>
      );
      break;
    case "checkbox":
      control = (
        <label
          htmlFor={inputId}
          className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3.5 ${
            value === true ? "border-phosphor bg-phosphor/[0.07]" : error ? "border-red-400" : "border-line"
          }`}
        >
          <input
            id={inputId}
            type="checkbox"
            checked={value === true}
            disabled={disabled}
            onChange={(e) => onChange(e.target.checked)}
            className="mt-0.5 h-4 w-4 accent-[#FFBB00]"
          />
          <span className="text-[14px] text-ink">
            {q.label}
            {q.required && <span className="text-phosphor-ink"> *</span>}
            {q.help && <span className="mt-0.5 block text-[13px] text-ink-soft">{q.help}</span>}
          </span>
        </label>
      );
      break;
  }

  return (
    <div id={id} className="scroll-mt-28">
      {labelEl}
      <div className={q.type === "checkbox" ? "" : "pl-0 sm:pl-7"}>
        {control}
        {error && (
          <p id={`${inputId}-error`} className="mt-1.5 text-[13px] text-red-600 dark:text-red-400" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

function DropZone({
  onFiles,
  accept,
  multiple,
  disabled,
  busy,
  title,
  hint,
  icon,
}: {
  onFiles: (files: FileList) => void;
  accept: string;
  multiple: boolean;
  disabled: boolean;
  busy: boolean;
  title: React.ReactNode;
  hint: string;
  icon: React.ReactNode;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const off = disabled || busy;
  return (
    <div
      role="button"
      tabIndex={off ? -1 : 0}
      aria-disabled={off}
      onClick={() => !off && ref.current?.click()}
      onKeyDown={(e) => {
        if ((e.key === "Enter" || e.key === " ") && !off) {
          e.preventDefault();
          ref.current?.click();
        }
      }}
      onDragOver={(e) => {
        e.preventDefault();
        if (!off) setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        if (!off && e.dataTransfer.files.length) onFiles(e.dataTransfer.files);
      }}
      onPaste={(e) => {
        if (!off && e.clipboardData.files.length) onFiles(e.clipboardData.files);
      }}
      className={`flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-xl border-2 border-dashed px-4 py-6 text-center ${
        over ? "border-phosphor bg-phosphor/10" : "border-line hover:border-ink/30 hover:bg-wash"
      } ${off ? "cursor-not-allowed opacity-60" : ""}`}
    >
      {busy ? <Loader2 className="h-5 w-5 animate-spin text-ink-soft" /> : icon}
      <div className="text-sm text-ink">{busy ? "Uploading…" : title}</div>
      <div className="text-[12px] text-ink-faint">{hint}</div>
      <input
        ref={ref}
        type="file"
        accept={accept}
        multiple={multiple}
        className="hidden"
        disabled={off}
        onChange={(e) => {
          if (e.target.files?.length) onFiles(e.target.files);
          e.target.value = "";
        }}
      />
    </div>
  );
}

function VideoControl({
  inputId,
  value,
  uploading,
  disabled,
  placeholder,
  error,
  onChange,
  onPick,
}: {
  inputId: string;
  value: string;
  uploading: boolean;
  disabled: boolean;
  placeholder: string;
  error?: string;
  onChange: (v: string) => void;
  onPick: (f: File) => void;
}) {
  const uploaded = isUploadAnswer(value);
  const kind = !uploaded && HTTP_URL_RE.test(value) ? linkKind(value) : null;
  if (uploaded) {
    const name = uploadPathOf(value).split("/").pop()?.replace(/^\d+-/, "") ?? "video";
    return (
      <div className="flex items-center justify-between gap-3 rounded-lg border border-phosphor/50 bg-phosphor/[0.07] px-3.5 py-3">
        <div className="flex min-w-0 items-center gap-2 text-sm text-ink">
          <CheckCircle2 className="h-4 w-4 shrink-0 text-phosphor-ink" />
          <span className="font-medium">Video uploaded</span>
          <span className="truncate text-ink-faint">· {name}</span>
        </div>
        {!disabled && (
          <button type="button" onClick={() => onChange("")} className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-ink-soft hover:text-ink">
            <X className="h-3.5 w-3.5" /> Replace
          </button>
        )}
      </div>
    );
  }
  return (
    <div className="space-y-2.5">
      <div className="relative">
        <Input
          id={inputId}
          type="url"
          inputMode="url"
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          onBlur={(e) => {
            const n = normalizeUrl(e.target.value);
            if (n !== e.target.value) onChange(n);
          }}
          placeholder={placeholder || "Paste a Loom, YouTube or Drive link"}
          error={error}
          className={kind ? "pr-28" : ""}
        />
        {kind && (
          <span className="pointer-events-none absolute right-2 top-1/2 inline-flex max-w-[6.5rem] -translate-y-1/2 items-center gap-1 truncate rounded bg-wash px-1.5 py-0.5 font-mono text-[10px] text-ink-soft">
            <Check className="h-3 w-3 text-phosphor-ink" /> {kind}
          </span>
        )}
      </div>
      {!value && (
        <>
          <div className="flex items-center gap-3 text-[11px] text-ink-faint">
            <span className="h-px flex-1 bg-line" /> or upload from your phone or computer
            <span className="h-px flex-1 bg-line" />
          </div>
          <DropZone
            onFiles={(fl) => fl[0] && onPick(fl[0])}
            accept={VIDEO_EXTENSIONS.map((e) => "." + e).join(",") + ",video/*"}
            multiple={false}
            disabled={disabled}
            busy={uploading}
            icon={<Upload className="h-5 w-5 text-ink-soft" />}
            title={
              <>
                <span className="font-medium text-phosphor-ink">Choose a video</span> or drop it here
              </>
            }
            hint={`MP4, MOV or WebM · up to ${Math.round(MAX_VIDEO_BYTES / 1024 / 1024)} MB`}
          />
        </>
      )}
    </div>
  );
}

function FileControl({
  q,
  inputId,
  files,
  uploading,
  disabled,
  previews,
  onRemove,
  onFiles,
}: {
  q: ChallengeQuestion;
  inputId: string;
  files: UploadedFile[];
  uploading: number;
  disabled: boolean;
  previews: Record<string, string>;
  onRemove: (path: string) => void;
  onFiles: (files: FileList | File[]) => void;
}) {
  const full = files.length >= q.maxFiles;
  const exts = extensionsFor(q.fileKind);
  return (
    <div className="space-y-3" id={inputId}>
      {files.length > 0 && (
        <ul className={q.fileKind === "image" ? "grid grid-cols-2 gap-2 sm:grid-cols-3" : "space-y-2"}>
          {files.map((f) => {
            const img = isImageFile(f) && previews[f.path];
            return q.fileKind === "image" && img ? (
              <li key={f.path} className="group relative overflow-hidden rounded-lg border border-line bg-wash">
                {/* eslint-disable-next-line @next/next/no-img-element -- local object URL / signed URL */}
                <img src={previews[f.path]} alt={f.name} className="aspect-video w-full object-cover" />
                {!disabled && (
                  <button
                    type="button"
                    onClick={() => onRemove(f.path)}
                    aria-label={`Remove ${f.name}`}
                    className="absolute right-1.5 top-1.5 rounded-md bg-paper/90 p-1 text-ink shadow-sm hover:bg-paper"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </li>
            ) : (
              <li key={f.path} className="flex items-center gap-2.5 rounded-md border border-line bg-paper px-3 py-2">
                {isImageFile(f) ? (
                  <ImageIcon className="h-4 w-4 shrink-0 text-ink-faint" />
                ) : (
                  <FileText className="h-4 w-4 shrink-0 text-ink-faint" />
                )}
                <span className="min-w-0 flex-1 truncate text-sm text-ink">{f.name}</span>
                <span className="shrink-0 font-mono text-[11px] text-ink-faint">{fmtBytes(f.size)}</span>
                {!disabled && (
                  <button type="button" onClick={() => onRemove(f.path)} aria-label={`Remove ${f.name}`} className="shrink-0 rounded p-1 text-ink-faint hover:bg-wash hover:text-ink">
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {!full && (
        <DropZone
          onFiles={onFiles}
          accept={acceptFor(q.fileKind) + (q.fileKind === "image" ? ",image/*" : "")}
          multiple={q.maxFiles - files.length > 1}
          disabled={disabled}
          busy={uploading > 0}
          icon={q.fileKind === "image" ? <ImageIcon className="h-5 w-5 text-ink-soft" /> : <Upload className="h-5 w-5 text-ink-soft" />}
          title={
            <>
              <span className="font-medium text-phosphor-ink">
                {q.fileKind === "image" ? "Add images" : "Add files"}
              </span>{" "}
              — drop, paste, or browse
            </>
          }
          hint={`${FILE_KIND_LABELS[q.fileKind]} (${exts.slice(0, 5).join(", ")}${exts.length > 5 ? "…" : ""}) · ${files.length}/${q.maxFiles} · up to ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB each`}
        />
      )}
    </div>
  );
}

function TeamControl({
  members,
  max,
  disabled,
  onChange,
}: {
  members: TeamMember[];
  max: number;
  disabled: boolean;
  onChange: (v: TeamMember[]) => void;
}) {
  const rows = members.length ? members : [];
  function update(i: number, patch: Partial<TeamMember>) {
    onChange(rows.map((m, j) => (j === i ? { ...m, ...patch } : m)));
  }
  return (
    <div className="space-y-2">
      {rows.map((m, i) => (
        <div key={i} className="flex gap-2">
          <Input
            aria-label={`Teammate ${i + 1} name`}
            value={m.name}
            disabled={disabled}
            onChange={(e) => update(i, { name: e.target.value })}
            placeholder="Name"
          />
          <Input
            aria-label={`Teammate ${i + 1} email`}
            type="email"
            value={m.email}
            disabled={disabled}
            onChange={(e) => update(i, { email: e.target.value })}
            placeholder="Email (optional)"
          />
          {!disabled && (
            <button
              type="button"
              onClick={() => onChange(rows.filter((_, j) => j !== i))}
              aria-label={`Remove teammate ${i + 1}`}
              className="shrink-0 rounded-md border border-line px-2.5 text-ink-faint hover:border-red-400/50 hover:text-red-500"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      ))}
      {!disabled && rows.length < max && (
        <button
          type="button"
          onClick={() => onChange([...rows, { name: "", email: "" }])}
          className="inline-flex items-center gap-1.5 rounded-md border border-dashed border-line px-3 py-2 text-[13px] font-medium text-ink-soft hover:border-ink/30 hover:text-ink"
        >
          <Plus className="h-3.5 w-3.5" /> Add teammate
          <span className="font-mono text-[11px] text-ink-faint">
            {rows.length}/{max}
          </span>
        </button>
      )}
    </div>
  );
}
