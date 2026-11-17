"use client";

import { useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/input";
import { formatBytes } from "@/lib/file-name-rules";
import {
  EMAIL_ATTACHMENT_ACCEPT,
  EMAIL_ATTACHMENT_BUCKET,
  EMAIL_ATTACHMENT_HINT,
  EMAIL_ATTACHMENT_MAX_FILES,
  EMAIL_ATTACHMENT_MAX_RECIPIENTS,
  EMAIL_ATTACHMENT_TOTAL_MAX_BYTES,
  attachmentsTotalBytes,
  checkEmailAttachmentSet,
  encodedSize,
  refuseForRecipientCount,
  type StagedEmailAttachment,
} from "@/lib/email-attachment-rules";
import { mintEmailAttachmentUploads } from "./attachment-actions";

/**
 * The compose form's attachment field.
 *
 * Picking a file uploads it immediately, straight into the private bucket
 * against a signed URL the server minted — nothing waits for the send. That
 * is not a nicety: a server action body caps at 1 MB, so the bytes could not
 * ride along with the draft even if we wanted them to.
 *
 * What the component owns is the list of finished uploads. It hands the
 * parent `StagedEmailAttachment[]`, which is paths and labels, never bytes.
 * Every check it runs is advisory and exists only to fail fast in a sentence
 * the person can act on; resolveAttachments re-measures everything server-side
 * before a message is built.
 */
export function AttachmentPicker({
  value,
  onChange,
  recipientCount,
  disabled,
}: {
  value: StagedEmailAttachment[];
  onChange: (next: StagedEmailAttachment[]) => void;
  /**
   * How many addresses the current recipient settings resolve to, or null
   * while that is still being counted. Only used to warn — the send action
   * enforces the cap, because this number is a count the browser was told.
   */
  recipientCount: number | null;
  disabled?: boolean;
}) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const total = attachmentsTotalBytes(value);
  const full = value.length >= EMAIL_ATTACHMENT_MAX_FILES;
  const recipientWarning =
    recipientCount === null ? null : refuseForRecipientCount(recipientCount, value.length);

  async function onPick(files: FileList | null) {
    if (!files || files.length === 0) return;
    setError(null);

    const picked = Array.from(files);
    // Check the whole prospective set, not just what was picked: the limits
    // are properties of the email, and five one-file picks must hit the same
    // wall one five-file pick does.
    const prospective = [
      ...value.map((v) => ({ name: v.name, size: v.size })),
      ...picked.map((f) => ({ name: f.name, size: f.size })),
    ];
    const problem = checkEmailAttachmentSet(prospective);
    if (problem) {
      setError(problem);
      if (inputRef.current) inputRef.current.value = "";
      return;
    }

    setBusy(true);
    try {
      const minted = await mintEmailAttachmentUploads(
        picked.map((f) => ({ name: f.name, size: f.size, type: f.type })),
        total,
      );
      if (!minted.ok) {
        setError(minted.error);
        return;
      }

      const { createClient } = await import("@/lib/supabase/client");
      const storage = createClient().storage.from(EMAIL_ATTACHMENT_BUCKET);

      const staged: StagedEmailAttachment[] = [];
      for (let i = 0; i < picked.length; i++) {
        const file = picked[i];
        const slot = minted.uploads[i];
        const up = await storage.uploadToSignedUrl(slot.path, slot.token, file, {
          contentType: file.type || undefined,
        });
        if (up.error) throw up.error;
        staged.push({
          path: slot.path,
          name: file.name,
          size: file.size,
          type: file.type || "",
        });
      }
      onChange([...value, ...staged]);
    } catch (e: any) {
      setError(e?.message ?? "That upload didn't finish. Try again.");
    } finally {
      setBusy(false);
      // Always clear, so picking the same file twice in a row still fires a
      // change event — otherwise a failed upload cannot be retried.
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  function remove(path: string) {
    // The object is left in the bucket. The sweeper reclaims anything no
    // unsent email points at after a day (sweepOrphanedAttachments), and
    // deleting here would mean a server round trip on every misclick plus a
    // way for a tampered request to delete by path.
    onChange(value.filter((v) => v.path !== path));
    setError(null);
  }

  return (
    <div>
      <Label htmlFor={inputId}>Attachments</Label>

      {value.length > 0 && (
        <ul className="mb-2 mt-1 space-y-1">
          {value.map((a) => (
            <li
              key={a.path}
              className="flex items-center justify-between gap-3 border border-line px-3 py-2 text-sm"
            >
              <span className="min-w-0 flex-1 truncate" title={a.name}>
                {a.name}
              </span>
              <span className="shrink-0 text-xs text-ink-faint">{formatBytes(a.size)}</span>
              <button
                type="button"
                onClick={() => remove(a.path)}
                disabled={disabled || busy}
                className="shrink-0 text-xs text-ink-faint underline hover:text-ink"
                aria-label={`Remove ${a.name}`}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      <input
        ref={inputRef}
        id={inputId}
        type="file"
        multiple
        accept={EMAIL_ATTACHMENT_ACCEPT}
        className="sr-only"
        disabled={disabled || busy || full}
        onChange={(e) => onPick(e.target.files)}
      />

      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="secondary"
          disabled={disabled || busy || full}
          onClick={() => inputRef.current?.click()}
        >
          {busy ? "Uploading…" : value.length > 0 ? "Add another file" : "Attach a file"}
        </Button>
        {value.length > 0 && (
          <span className="text-xs text-ink-faint">
            {formatBytes(total)} of {formatBytes(EMAIL_ATTACHMENT_TOTAL_MAX_BYTES)}
            {/* The number that actually bounces is the encoded one, so once a
                send is big enough for that to matter, show it. */}
            {total > EMAIL_ATTACHMENT_TOTAL_MAX_BYTES / 2 &&
              ` · ~${formatBytes(encodedSize(total))} once encoded for email`}
          </span>
        )}
      </div>

      <p className="mt-2 text-xs text-ink-faint">
        {full
          ? `That's the limit of ${EMAIL_ATTACHMENT_MAX_FILES} files. Remove one to attach another.`
          : EMAIL_ATTACHMENT_HINT}
      </p>

      {recipientWarning && (
        <p className="mt-2 border-l-2 border-phosphor bg-wash px-3 py-2 text-xs text-ink">
          {recipientWarning}
        </p>
      )}

      {error && (
        <p className="mt-2 text-xs text-error" role="alert">
          {error}
        </p>
      )}

      {value.length > 0 && recipientCount !== null && recipientCount > 1 && !recipientWarning && (
        <p className="mt-2 text-xs text-ink-faint">
          Every one of the {recipientCount} recipients gets their own copy of{" "}
          {value.length === 1 ? "this file" : "these files"}. Attachments are capped at{" "}
          {EMAIL_ATTACHMENT_MAX_RECIPIENTS} addresses per send.
        </p>
      )}
    </div>
  );
}
