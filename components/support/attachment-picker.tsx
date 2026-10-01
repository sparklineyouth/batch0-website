"use client";
import { useEffect, useId, useRef, useState } from "react";
import {
  AlertCircle,
  Check,
  FileText,
  Film,
  ImageIcon,
  Loader2,
  Paperclip,
  RefreshCw,
  X,
} from "lucide-react";
import { mintSupportUploads } from "@/app/support/attachment-actions";
import { getActionError } from "@/lib/action-error";
import { withUploadRetry } from "@/lib/upload-retry";
import {
  ATTACHMENT_ACCEPT,
  ATTACHMENT_BUCKET,
  ATTACHMENT_HINT,
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MAX_FILES,
  attachmentKind,
  checkAttachmentFile,
  displayFileName,
  formatBytes,
  isImageType,
  type AttachmentScope,
  type MintResult,
  type MintedUpload,
  type StagedAttachment,
} from "@/lib/support-attachment-rules";

/**
 * Attach files to a support request, a follow-up, or a staff reply.
 *
 * It owns the whole upload and hands the form one thing: a hidden input named
 * `name` whose value is `JSON.stringify(StagedAttachment[])` — the files that
 * finished uploading, and only those. The form's action passes that string to
 * recordAttachments (lib/support-attachments.ts), which trusts none of it until
 * it has looked at what actually landed in storage.
 *
 * Per file: check it here (checkAttachmentFile — the same sentence the server
 * would say), ask the server for a signed upload URL scoped to `scope`, then
 * put the bytes straight into the private bucket, retried through a network
 * blip and never past a refusal (lib/upload-retry.ts). Each file shows its own
 * state — uploading, done, or failed with the reason and a retry — and can be
 * removed at any point. `onBusyChange` tells the form when anything is still
 * uploading, so it can hold its submit button: a message sent mid-upload goes
 * without the file the person thinks is on it.
 *
 * `resetKey`: change it after a successful send to clear the picker for the
 * next message. `compact`: the phone layout for the installed app — one big
 * button, bigger rows, no drag-and-drop copy. Screenshots can also be pasted
 * anywhere in the surrounding form, which is how most "tech help" requests
 * want to arrive.
 *
 * The Supabase browser client is imported inside the upload, never at the top
 * of this file: a static import would put supabase-js in the first load of
 * every page that renders a support form, for the minority who attach.
 */

type Status = "uploading" | "uploaded" | "failed";

type Item = {
  key: string;
  file: File;
  /** Cleaned for display; the server stores its own cleaned copy. */
  name: string;
  status: Status;
  /** Set once the bytes are in the bucket. The only thing the form posts. */
  path?: string;
  error?: string;
  /** Object URL for a browser-renderable image — revoked when the item goes. */
  preview?: string;
};

let lastKey = 0;
const nextKey = () => `attachment-${++lastKey}`;

function sameFile(a: File, b: File): boolean {
  return a.name === b.name && a.size === b.size && a.lastModified === b.lastModified;
}

/**
 * A retried upload that finds its object already there. The path is unique
 * per mint, so this means an earlier attempt landed and only its response
 * was lost — which is success. (recordAttachments checks the bytes anyway.)
 */
function alreadyStored(err: unknown): boolean {
  const e = err as { statusCode?: unknown; message?: unknown } | null;
  return (
    String(e?.statusCode ?? "") === "409" ||
    /already exists|duplicate/i.test(String(e?.message ?? ""))
  );
}

/** Storage's own errors are written for developers. Say what happened instead. */
function uploadFailure(err: unknown): string {
  const e = err as { status?: unknown; statusCode?: unknown; message?: unknown } | null;
  const status = Number(e?.status ?? e?.statusCode);
  const message = String(e?.message ?? "");
  if (status === 413 || /maximum allowed size|too large/i.test(message)) {
    return `Over the ${formatBytes(ATTACHMENT_MAX_BYTES)} limit.`;
  }
  if (/expired|signature|jwt/i.test(message)) {
    return "The upload link expired. Retry to get a fresh one.";
  }
  return "The upload didn't go through. Check your connection and retry.";
}

async function putFile(target: MintedUpload, file: File): Promise<void> {
  // Deferred import: see the note at the top of the file.
  const { createClient } = await import("@/lib/supabase/client");
  const bucket = createClient().storage.from(ATTACHMENT_BUCKET);
  let attempt = 0;
  await withUploadRetry(async () => {
    attempt += 1;
    const { error } = await bucket.uploadToSignedUrl(target.path, target.token, file, {
      contentType: file.type || undefined,
    });
    if (!error || (attempt > 1 && alreadyStored(error))) return;
    throw error;
  });
}

export function AttachmentPicker({
  scope,
  name = "attachments",
  max = ATTACHMENT_MAX_FILES,
  disabled = false,
  onBusyChange,
  compact = false,
  resetKey,
}: {
  /** Who is uploading, and onto what — see AttachmentScope. */
  scope: AttachmentScope;
  /** The hidden input's name. */
  name?: string;
  /** Capped at ATTACHMENT_MAX_FILES whatever is passed. */
  max?: number;
  disabled?: boolean;
  onBusyChange?: (busy: boolean) => void;
  compact?: boolean;
  /** Change to clear every file — after a successful send. */
  resetKey?: string | number;
}) {
  const limit = Math.max(
    1,
    Math.min(ATTACHMENT_MAX_FILES, Math.floor(max) || ATTACHMENT_MAX_FILES),
  );
  const [items, setItems] = useState<Item[]>([]);
  // The source of truth for the async upload callbacks, which outlive the
  // render that started them; `items` is its rendered copy.
  const itemsRef = useRef<Item[]>([]);
  const [problems, setProblems] = useState<string[]>([]);
  const [announcement, setAnnouncement] = useState("");
  const [over, setOver] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const hintId = useId();

  function commit(next: Item[]) {
    itemsRef.current = next;
    setItems(next);
  }

  /** Update one file, unless it was removed (or the picker reset) meanwhile. */
  function patch(key: string, change: Partial<Item>) {
    const current = itemsRef.current;
    if (!current.some((i) => i.key === key)) return;
    commit(current.map((i) => (i.key === key ? { ...i, ...change } : i)));
  }

  /** Is any of this batch still on screen? Nothing to announce about files that were removed. */
  function stillShown(batch: Item[]) {
    return batch.some((b) => itemsRef.current.some((i) => i.key === b.key));
  }

  const busy = items.some((i) => i.status === "uploading");
  const full = items.length >= limit;
  const canAdd = !disabled && !full;

  // Latest callbacks for listeners registered once.
  const onBusyRef = useRef(onBusyChange);
  const addFilesRef = useRef(addFiles);
  useEffect(() => {
    onBusyRef.current = onBusyChange;
    addFilesRef.current = addFiles;
  });

  // After a remove, focus goes back to the attach button — once the removal
  // has rendered, because a full picker's button is still disabled until then.
  const refocus = useRef(false);
  useEffect(() => {
    if (!refocus.current) return;
    refocus.current = false;
    buttonRef.current?.focus();
  });

  useEffect(() => {
    onBusyRef.current?.(busy);
  }, [busy]);

  // Unmounting mid-upload must not leave the parent's submit button held.
  useEffect(
    () => () => {
      onBusyRef.current?.(false);
      for (const i of itemsRef.current) if (i.preview) URL.revokeObjectURL(i.preview);
    },
    [],
  );

  const lastResetKey = useRef(resetKey);
  useEffect(() => {
    if (Object.is(lastResetKey.current, resetKey)) return;
    lastResetKey.current = resetKey;
    for (const i of itemsRef.current) if (i.preview) URL.revokeObjectURL(i.preview);
    itemsRef.current = [];
    setItems([]);
    setProblems([]);
    setAnnouncement("");
  }, [resetKey]);

  // Paste a screenshot anywhere in the form — into the message box, usually.
  // Registered natively on the form (not just on this component) because the
  // text area is where focus is when someone presses ⌘V.
  useEffect(() => {
    const root = rootRef.current;
    const target: HTMLElement | null = root?.closest("form") ?? root;
    if (!target) return;
    const onPaste = (e: ClipboardEvent) => {
      const files = e.clipboardData?.files;
      if (!files || files.length === 0) return;
      // Text that arrives with a picture of itself (a spreadsheet range,
      // rich text from a doc) is a text paste, not an attachment.
      if (e.clipboardData?.getData("text/plain")) return;
      e.preventDefault();
      addFilesRef.current(files);
    };
    target.addEventListener("paste", onPaste);
    return () => target.removeEventListener("paste", onPaste);
  }, []);

  function addFiles(list: FileList | File[]) {
    if (disabled) return;
    const picked = Array.from(list);
    if (picked.length === 0) return;

    const current = itemsRef.current;
    const room = limit - current.length;
    const messages: string[] = [];
    const accepted: File[] = [];
    let leftOff = 0;
    for (const file of picked) {
      // Picking the same file twice adds it once.
      if (current.some((i) => sameFile(i.file, file)) || accepted.some((f) => sameFile(f, file))) {
        continue;
      }
      const problem = checkAttachmentFile({ name: file.name, size: file.size });
      if (problem) {
        messages.push(problem);
        continue;
      }
      if (accepted.length >= room) {
        leftOff += 1;
        continue;
      }
      accepted.push(file);
    }
    if (leftOff > 0) {
      messages.push(
        room <= 0
          ? `You can attach up to ${limit} files to one message. Remove one to add another.`
          : `Only ${limit} files fit on one message, so ${
              leftOff === 1 ? "one was" : `${leftOff} were`
            } left off.`,
      );
    }
    setProblems(messages);
    if (accepted.length === 0) return;

    const batch: Item[] = accepted.map((file) => ({
      key: nextKey(),
      file,
      name: displayFileName(file.name),
      status: "uploading",
      preview: isImageType(file.type) ? URL.createObjectURL(file) : undefined,
    }));
    commit([...current, ...batch]);
    void upload(batch);
  }

  async function upload(batch: Item[]) {
    setAnnouncement(
      batch.length === 1 ? `Uploading ${batch[0].name}.` : `Uploading ${batch.length} files.`,
    );

    let minted: MintResult;
    try {
      minted = await mintSupportUploads(
        scope,
        batch.map((i) => ({ name: i.file.name, size: i.file.size, type: i.file.type })),
      );
    } catch (err) {
      minted = {
        ok: false,
        error: getActionError(err, "We couldn't start the upload. Try again in a moment."),
      };
    }
    if (!minted.ok) {
      const error = minted.error;
      for (const item of batch) patch(item.key, { status: "failed", error });
      if (stillShown(batch)) setAnnouncement(error);
      return;
    }

    const uploads = minted.uploads;
    const results = await Promise.all(
      batch.map(async (item, index) => {
        const target = uploads[index];
        try {
          if (!target) throw new Error("missing upload URL");
          await putFile(target, item.file);
          patch(item.key, { status: "uploaded", path: target.path, error: undefined });
          return true;
        } catch (err) {
          patch(item.key, { status: "failed", error: uploadFailure(err) });
          return false;
        }
      }),
    );

    if (!stillShown(batch)) return;
    const failed = results.filter((ok) => !ok).length;
    setAnnouncement(
      failed === 0
        ? batch.length === 1
          ? `${batch[0].name} is attached.`
          : `${batch.length} files are attached.`
        : `${failed} of ${batch.length} ${batch.length === 1 ? "upload" : "uploads"} failed.`,
    );
  }

  function retry(key: string) {
    if (disabled) return;
    const item = itemsRef.current.find((i) => i.key === key);
    if (!item || item.status !== "failed") return;
    // A fresh URL rather than the old one: the usual reason for a failure that
    // survived the automatic retries is a link that has since expired.
    const again: Item = { ...item, status: "uploading", error: undefined, path: undefined };
    commit(itemsRef.current.map((i) => (i.key === key ? again : i)));
    void upload([again]);
  }

  function remove(key: string) {
    if (disabled) return;
    const item = itemsRef.current.find((i) => i.key === key);
    if (!item) return;
    if (item.preview) URL.revokeObjectURL(item.preview);
    commit(itemsRef.current.filter((i) => i.key !== key));
    setProblems([]);
    setAnnouncement(`Removed ${item.name}.`);
    // The button that had focus just left the page with its row.
    refocus.current = true;
  }

  function openPicker() {
    if (canAdd) inputRef.current?.click();
  }

  const staged: StagedAttachment[] = items
    .filter((i) => i.status === "uploaded" && i.path)
    .map((i) => ({ path: i.path!, name: i.file.name, size: i.file.size, type: i.file.type }));

  const fullLabel = `${limit} of ${limit} files attached`;

  return (
    <div
      ref={rootRef}
      className={compact ? "space-y-2.5" : "space-y-2"}
      // Always swallow a file dragged over the zone, even when it can't take
      // one — otherwise the browser's default is to open the dropped file in
      // place of this page, taking the half-written message with it.
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        if (canAdd) setOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setOver(false);
        if (canAdd && e.dataTransfer.files.length > 0) addFiles(e.dataTransfer.files);
      }}
    >
      {compact ? (
        <button
          ref={buttonRef}
          type="button"
          onClick={openPicker}
          disabled={!canAdd}
          aria-describedby={hintId}
          className="press flex h-12 w-full select-none items-center justify-center gap-2 rounded-xl border border-line bg-wash text-[14px] font-medium text-ink active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50 disabled:active:scale-100"
        >
          <Paperclip className="h-4 w-4 text-ink-soft" aria-hidden />
          {full ? fullLabel : "Add photos or files"}
        </button>
      ) : (
        <button
          ref={buttonRef}
          type="button"
          onClick={openPicker}
          disabled={!canAdd}
          aria-describedby={hintId}
          className={`press flex w-full select-none items-center justify-center gap-2 rounded-lg border border-dashed px-4 py-3.5 text-sm active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-phosphor focus-visible:ring-offset-2 focus-visible:ring-offset-paper disabled:cursor-not-allowed disabled:opacity-60 disabled:active:scale-100 ${
            over ? "border-phosphor bg-phosphor/10" : "border-line hover:border-ink/30 hover:bg-wash"
          }`}
        >
          <Paperclip className="h-4 w-4 shrink-0 text-ink-soft" aria-hidden />
          {full ? (
            <span className="text-ink-soft">{fullLabel}</span>
          ) : (
            <span>
              <span className="font-medium text-phosphor-ink">Attach files</span>
              <span className="text-ink-faint"> — drop, paste, or browse</span>
            </span>
          )}
        </button>
      )}

      <p id={hintId} className={compact ? "text-[11px] leading-snug text-ink-faint" : "text-xs text-ink-faint"}>
        {ATTACHMENT_HINT}
      </p>

      <input
        ref={inputRef}
        type="file"
        multiple={limit - items.length > 1}
        accept={ATTACHMENT_ACCEPT}
        className="hidden"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(e) => {
          if (e.target.files?.length) addFiles(e.target.files);
          // Cleared so picking the same file again (after removing it) fires.
          e.target.value = "";
        }}
      />

      {problems.length > 0 && (
        <div
          role="alert"
          className={
            compact
              ? "space-y-1 rounded-lg border border-red-500/30 bg-red-500/10 px-3.5 py-2.5 text-[13px] text-red-600 dark:text-red-300"
              : "space-y-0.5 text-xs text-red-700 dark:text-red-300"
          }
        >
          {problems.map((p, i) => (
            <p key={i}>{p}</p>
          ))}
        </div>
      )}

      {items.length > 0 && (
        <ul aria-label="Attached files" className={compact ? "space-y-2" : "space-y-1.5"}>
          {items.map((item) => (
            <ItemRow
              key={item.key}
              item={item}
              compact={compact}
              disabled={disabled}
              onRetry={() => retry(item.key)}
              onRemove={() => remove(item.key)}
            />
          ))}
        </ul>
      )}

      <input type="hidden" name={name} value={JSON.stringify(staged)} />
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>
    </div>
  );
}

function ItemRow({
  item,
  compact,
  disabled,
  onRetry,
  onRemove,
}: {
  item: Item;
  compact: boolean;
  disabled: boolean;
  onRetry: () => void;
  onRemove: () => void;
}) {
  const kind = attachmentKind({ contentType: item.file.type, fileName: item.file.name });
  const Icon = kind === "image" ? ImageIcon : kind === "video" ? Film : FileText;
  const thumb = compact ? "h-10 w-10 rounded-lg" : "h-8 w-8 rounded";
  const iconButton = compact
    ? "press flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-ink-faint active:bg-wash disabled:opacity-50"
    : "press flex h-7 w-7 shrink-0 items-center justify-center rounded text-ink-faint hover:bg-wash hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-phosphor focus-visible:ring-offset-2 focus-visible:ring-offset-paper disabled:opacity-50";
  const failed = item.status === "failed";

  return (
    <li
      className={`flex items-center gap-2.5 border bg-paper ${
        failed ? "border-red-400/50" : "border-line"
      } ${compact ? "rounded-xl px-3 py-2.5" : "rounded-md px-2.5 py-2"}`}
    >
      {item.preview ? (
        // eslint-disable-next-line @next/next/no-img-element -- a local object URL, never a remote image
        <img src={item.preview} alt="" className={`${thumb} shrink-0 bg-wash object-cover`} />
      ) : (
        <span aria-hidden className={`${thumb} flex shrink-0 items-center justify-center bg-wash`}>
          <Icon className="h-4 w-4 text-ink-faint" />
        </span>
      )}

      <div className="min-w-0 flex-1">
        <p className={`truncate text-ink ${compact ? "text-[14px]" : "text-sm"}`}>{item.name}</p>
        {failed ? (
          <p className="mt-0.5 flex items-start gap-1 text-[11px] leading-snug text-red-700 dark:text-red-300">
            <AlertCircle className="mt-px h-3 w-3 shrink-0" aria-hidden />
            <span>{item.error}</span>
          </p>
        ) : (
          <p className="mt-0.5 flex items-center gap-1 font-mono text-[11px] text-ink-faint">
            {item.status === "uploading" ? (
              <>
                <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                Uploading… · {formatBytes(item.file.size)}
              </>
            ) : (
              <>
                <Check className="h-3 w-3 text-phosphor-ink" aria-hidden />
                {formatBytes(item.file.size)}
                <span className="sr-only">, attached</span>
              </>
            )}
          </p>
        )}
      </div>

      {failed && (
        <button
          type="button"
          onClick={onRetry}
          disabled={disabled}
          aria-label={`Retry ${item.name}`}
          className={iconButton}
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
      )}
      <button
        type="button"
        onClick={onRemove}
        disabled={disabled}
        aria-label={`Remove ${item.name}`}
        className={iconButton}
      >
        <X className={compact ? "h-4 w-4" : "h-3.5 w-3.5"} />
      </button>
    </li>
  );
}
