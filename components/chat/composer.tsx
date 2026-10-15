"use client";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Loader2, Paperclip, Send, SmilePlus, X, FileText } from "lucide-react";
import { MESSAGE_MAX } from "@/lib/chat-access";
import { encodeMentions, mentionQueryAt, plainText, type PickedMention } from "@/lib/chat-format";
import {
  ATTACHMENT_ACCEPT,
  CHAT_FILES_BUCKET,
  CHAT_FILES_HINT,
  CHAT_MAX_FILES,
  checkAttachmentFile,
  formatBytes,
} from "@/lib/chat-files-rules";
import { mintUploads } from "@/app/chat/actions";
import { Avatar } from "./avatar";
import { EmojiGrid, Popover } from "./popover";
import { imeComposing, resultError } from "./util";
import type { ChatPerson, UiMessage } from "./types";

type Staged = { key: string; path: string | null; name: string; size: number; type: string; progress: "uploading" | "done" | "error"; error?: string };

/**
 * The composer. Enter sends, Shift+Enter is a newline, ↑ in an empty box
 * edits your last message, Escape drops a reply. "@" opens the people who can
 * read the channel; the box shows "@Maya Chen", the message stores <@id>.
 * Files go straight to private storage on a one-shot URL before the message
 * is sent (lib/chat-files-rules.ts), by picker, paste or drop.
 */
export function Composer({
  channelId,
  placeholder,
  disabledReason,
  slowmodeWait,
  slowmodeSeconds = 0,
  replyTo,
  onCancelReply,
  people,
  candidates,
  onSend,
  onTyping,
  onEditLast,
  canMentionEveryone,
  draftKey,
}: {
  channelId: string | null;
  placeholder: string;
  disabledReason: string | null;
  slowmodeWait: number;
  /** The wait a send starts here (0 for staff, DMs, and channels without slow mode). */
  slowmodeSeconds?: number;
  replyTo: UiMessage | null;
  onCancelReply: () => void;
  people: Record<string, ChatPerson>;
  /** Who the "@" menu offers. */
  candidates: ChatPerson[];
  onSend: (input: { body: string; replyTo: UiMessage | null; attachments: { path: string; name: string; size: number; type: string }[] }) => void;
  onTyping: () => void;
  onEditLast: () => void;
  canMentionEveryone: boolean;
  /** Drafts are kept per channel while the page is open. */
  draftKey: string;
}) {
  const [text, setText] = useState("");
  const [picked, setPicked] = useState<PickedMention[]>([]);
  const [files, setFiles] = useState<Staged[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [wait, setWait] = useState(slowmodeWait);
  const [dragging, setDragging] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const drafts = useRef(new Map<string, { text: string; picked: PickedMention[] }>());
  const currentKey = useRef(draftKey);

  // Switching channels stashes this draft and restores that one's.
  useEffect(() => {
    if (currentKey.current !== draftKey) {
      drafts.current.set(currentKey.current, { text, picked });
      const next = drafts.current.get(draftKey);
      setText(next?.text ?? "");
      setPicked(next?.picked ?? []);
      setFiles([]);
      setFileError(null);
      setMention(null);
      currentKey.current = draftKey;
    }
    // Desktop only: on a phone, focusing would throw the keyboard up over
    // the conversation every time one opens.
    if (window.matchMedia("(min-width: 768px)").matches) ref.current?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey]);

  useEffect(() => {
    if (replyTo) ref.current?.focus();
  }, [replyTo]);

  // Slow mode counts down locally.
  useEffect(() => setWait(slowmodeWait), [slowmodeWait, draftKey]);
  useEffect(() => {
    if (wait <= 0) return;
    const t = setTimeout(() => setWait((w) => Math.max(0, w - 1)), 1000);
    return () => clearTimeout(t);
  }, [wait]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, Math.round(window.innerHeight * 0.4))}px`;
  }, [text]);

  const options = useMemo(() => {
    if (!mention) return [];
    const q = mention.query.toLowerCase();
    const list: { id: string; name: string; label: string; person?: ChatPerson }[] = [];
    if (canMentionEveryone) {
      for (const v of ["everyone", "here"]) if (v.startsWith(q)) list.push({ id: `@${v}`, name: v, label: `@${v}` });
    }
    for (const p of candidates) {
      if (!q || p.name.toLowerCase().includes(q)) list.push({ id: p.id, name: p.name, label: p.name, person: p });
      if (list.length >= 8) break;
    }
    return list;
  }, [mention, candidates, canMentionEveryone]);

  useEffect(() => setMentionIndex(0), [mention?.query]);

  const disabled = !!disabledReason;
  const uploading = files.some((f) => f.progress === "uploading");
  const ready = files.filter((f) => f.progress === "done" && f.path);
  const over = text.length > MESSAGE_MAX;
  const canSend = !disabled && !uploading && wait === 0 && !over && (text.trim().length > 0 || ready.length > 0);

  const submit = useCallback(() => {
    if (!canSend) return;
    const body = encodeMentions(text.trim(), picked);
    onSend({
      body,
      replyTo,
      attachments: ready.map((f) => ({ path: f.path!, name: f.name, size: f.size, type: f.type })),
    });
    setText("");
    setPicked([]);
    setFiles([]);
    setMention(null);
    drafts.current.delete(draftKey);
    onCancelReply();
    // Start the countdown now; otherwise the next message goes up looking
    // sent and comes back refused by slow mode.
    if (slowmodeSeconds > 0) setWait(slowmodeSeconds);
  }, [canSend, text, picked, onSend, replyTo, ready, draftKey, onCancelReply, slowmodeSeconds]);

  const choose = (opt: { id: string; name: string }) => {
    if (!mention) return;
    const insert = opt.id.startsWith("@") ? `@${opt.name} ` : `@${opt.name} `;
    const before = text.slice(0, mention.start);
    const after = text.slice(mention.start + 1 + mention.query.length);
    const next = before + insert + after;
    setText(next);
    if (!opt.id.startsWith("@")) setPicked((p) => [...p.filter((x) => x.id !== opt.id), { id: opt.id, name: opt.name }]);
    setMention(null);
    requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      const pos = before.length + insert.length;
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  };

  const updateMention = (value: string, caret: number) => {
    setMention(mentionQueryAt(value, caret));
  };

  // ---------------------------------------------------------------------------
  // Files
  // ---------------------------------------------------------------------------

  const addFiles = async (list: File[]) => {
    setFileError(null);
    if (!channelId) {
      setFileError("Send a first message, then you can attach files here.");
      return;
    }
    const room = CHAT_MAX_FILES - files.length;
    if (room <= 0) {
      setFileError(`Up to ${CHAT_MAX_FILES} files on one message.`);
      return;
    }
    const picks = list.slice(0, room);
    for (const f of picks) {
      const problem = checkAttachmentFile({ name: f.name, size: f.size });
      if (problem) {
        setFileError(problem);
        return;
      }
    }
    const staged: Staged[] = picks.map((f, i) => ({
      key: `${Date.now()}-${i}-${f.name}`,
      path: null,
      name: f.name,
      size: f.size,
      type: f.type,
      progress: "uploading",
    }));
    setFiles((prev) => [...prev, ...staged]);
    const minted = await mintUploads(
      channelId,
      picks.map((f) => ({ name: f.name, size: f.size, type: f.type })),
    ).catch((err) => ({ ok: false as const, error: err instanceof Error ? err.message : "Couldn't upload." }));
    if (!minted.ok || !minted.data) {
      const why = resultError(minted, "Couldn't upload that file.");
      setFiles((prev) => prev.filter((f) => !staged.some((s) => s.key === f.key)));
      setFileError(why);
      return;
    }
    const { createClient } = await import("@/lib/supabase/client");
    const bucket = createClient().storage.from(CHAT_FILES_BUCKET);
    await Promise.all(
      minted.data.uploads.map(async (u, i) => {
        const key = staged[i].key;
        const { error } = await bucket.uploadToSignedUrl(u.path, u.token, picks[i], {
          contentType: picks[i].type || undefined,
        });
        setFiles((prev) =>
          prev.map((f) =>
            f.key === key
              ? error
                ? { ...f, progress: "error", error: "Upload failed" }
                : { ...f, path: u.path, progress: "done" }
              : f,
          ),
        );
      }),
    );
  };

  return (
    <div
      className="relative shrink-0 px-3 pb-[calc(0.75rem+var(--safe-bottom))] md:px-5"
      onDragOver={(e) => {
        if (disabled || !e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        if (disabled) return;
        e.preventDefault();
        setDragging(false);
        const list = Array.from(e.dataTransfer.files ?? []);
        if (list.length) void addFiles(list);
      }}
    >
      {mention && options.length > 0 ? (
        <div className="absolute bottom-full left-3 right-3 z-20 mb-1 max-h-72 overflow-y-auto rounded-md border border-line bg-paper p-1 shadow-[0_8px_24px_rgb(0_0_0/0.12)] md:left-5 md:right-5">
          <p className="px-2 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">Mention</p>
          {options.map((o, i) => (
            <button
              key={o.id}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                choose(o);
              }}
              className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm ${i === mentionIndex ? "bg-wash" : "hover:bg-wash"}`}
            >
              {o.person ? <Avatar name={o.person.name} size={22} /> : <span className="inline-flex h-[22px] w-[22px] items-center justify-center rounded-md border border-line font-mono text-[11px]">@</span>}
              <span className="truncate text-ink">{o.label}</span>
              {o.person?.roleLabel ? <span className="ml-auto font-mono text-[10px] text-ink-faint">{o.person.roleLabel}</span> : null}
              {o.id === "@everyone" ? <span className="ml-auto text-[11px] text-ink-faint">Pings everyone here</span> : null}
            </button>
          ))}
        </div>
      ) : null}

      <div
        className={`rounded-md border bg-paper ${dragging ? "border-phosphor ring-2 ring-phosphor/40" : "border-line focus-within:border-ink/40"} ${disabled ? "opacity-70" : ""}`}
      >
        {replyTo ? (
          <div className="flex items-center gap-2 border-b border-line px-3 py-1.5 text-xs text-ink-soft">
            <span className="min-w-0 flex-1 truncate">
              Replying to <strong className="text-ink">{replyTo.senderId ? (people[replyTo.senderId]?.name ?? "someone") : "batch0"}</strong>
              <span className="ml-2 text-ink-faint">{plainText(replyTo.body, (id) => people[id]?.name, () => null, 80)}</span>
            </span>
            <button type="button" onClick={onCancelReply} aria-label="Cancel reply" className="rounded p-0.5 hover:bg-wash">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : null}

        {files.length > 0 ? (
          <div className="flex flex-wrap gap-2 border-b border-line p-2">
            {files.map((f) => (
              <span
                key={f.key}
                className={`inline-flex max-w-[14rem] items-center gap-2 rounded-md border px-2 py-1 text-xs ${f.progress === "error" ? "border-red-500/50 text-red-600 dark:text-red-400" : "border-line text-ink-soft"}`}
              >
                {f.progress === "uploading" ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" /> : <FileText className="h-3.5 w-3.5 shrink-0" />}
                <span className="min-w-0 truncate">{f.name}</span>
                <span className="shrink-0 font-mono text-[10px] text-ink-faint">{f.error ?? formatBytes(f.size)}</span>
                <button
                  type="button"
                  onClick={() => setFiles((prev) => prev.filter((x) => x.key !== f.key))}
                  aria-label={`Remove ${f.name}`}
                  className="shrink-0 rounded hover:bg-wash"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        ) : null}

        <div className="flex items-end gap-1 p-1.5">
          <button
            type="button"
            disabled={disabled}
            onClick={() => fileInput.current?.click()}
            aria-label="Attach files"
            title={CHAT_FILES_HINT}
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-ink-faint hover:bg-wash hover:text-ink disabled:opacity-40"
          >
            <Paperclip className="h-4 w-4" />
          </button>
          <input
            ref={fileInput}
            type="file"
            multiple
            accept={ATTACHMENT_ACCEPT}
            className="hidden"
            onChange={(e) => {
              const list = Array.from(e.target.files ?? []);
              e.target.value = "";
              if (list.length) void addFiles(list);
            }}
          />
          <label htmlFor="chat-composer" className="sr-only">
            {placeholder}
          </label>
          <textarea
            id="chat-composer"
            ref={ref}
            value={text}
            disabled={disabled}
            rows={1}
            placeholder={disabledReason ?? placeholder}
            onChange={(e) => {
              setText(e.target.value);
              updateMention(e.target.value, e.target.selectionStart ?? e.target.value.length);
              if (e.target.value) onTyping();
            }}
            onSelect={(e) => {
              const el = e.currentTarget;
              updateMention(el.value, el.selectionStart ?? el.value.length);
            }}
            onPaste={(e) => {
              const list = Array.from(e.clipboardData?.files ?? []);
              if (list.length) {
                e.preventDefault();
                void addFiles(list);
              }
            }}
            onKeyDown={(e) => {
              if (imeComposing(e)) return;
              if (mention && options.length > 0) {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setMentionIndex((i) => (i + 1) % options.length);
                  return;
                }
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setMentionIndex((i) => (i - 1 + options.length) % options.length);
                  return;
                }
                if (e.key === "Enter" || e.key === "Tab") {
                  e.preventDefault();
                  choose(options[mentionIndex]);
                  return;
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  setMention(null);
                  return;
                }
              }
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              } else if (e.key === "ArrowUp" && !text) {
                e.preventDefault();
                onEditLast();
              } else if (e.key === "Escape" && replyTo) {
                e.preventDefault();
                onCancelReply();
              }
            }}
            className="max-h-[40vh] min-h-[36px] flex-1 resize-none bg-transparent px-1.5 py-2 text-[15px] leading-snug text-ink placeholder:text-ink-faint focus:outline-none disabled:cursor-not-allowed"
          />
          <div className="relative">
            <button
              type="button"
              disabled={disabled}
              onClick={() => setEmojiOpen((o) => !o)}
              aria-label="Insert emoji"
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-ink-faint hover:bg-wash hover:text-ink disabled:opacity-40"
            >
              <SmilePlus className="h-4 w-4" />
            </button>
            <Popover open={emojiOpen} onClose={() => setEmojiOpen(false)} className="bottom-11 right-0">
              <EmojiGrid
                label="Insert an emoji"
                onPick={(emoji) => {
                  const el = ref.current;
                  const at = el?.selectionStart ?? text.length;
                  const next = text.slice(0, at) + emoji + text.slice(at);
                  setText(next);
                  setEmojiOpen(false);
                  requestAnimationFrame(() => {
                    el?.focus();
                    el?.setSelectionRange(at + emoji.length, at + emoji.length);
                  });
                }}
              />
            </Popover>
          </div>
          <button
            type="button"
            onClick={submit}
            disabled={!canSend}
            aria-label="Send"
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-phosphor text-on-phosphor hover:bg-phosphor-200 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Send className="h-4 w-4" />
          </button>
        </div>
      </div>
      <div className="mt-1 flex min-h-4 items-center justify-between gap-3 px-1 text-[11px] text-ink-faint">
        <span className="min-w-0 truncate">
          {fileError ? <span className="text-red-600 dark:text-red-400">{fileError}</span> : wait > 0 ? `Slow mode: you can post again in ${wait}s` : null}
        </span>
        {text.length > MESSAGE_MAX - 400 ? (
          <span className={`shrink-0 font-mono ${over ? "text-red-600 dark:text-red-400" : ""}`}>
            {(MESSAGE_MAX - text.length).toLocaleString()}
          </span>
        ) : (
          <span className="hidden shrink-0 md:inline">
            **bold** *italic* `code` ||spoiler|| · Shift+Enter for a new line
          </span>
        )}
      </div>
    </div>
  );
}
