"use client";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { BookOpen, Loader2, Paperclip, Send, SmilePlus, X, FileText } from "lucide-react";
import { MESSAGE_MAX } from "@/lib/chat-access";
import type { AboutChip } from "@/lib/chat-threads-rules";
import { composeMessage, mentionQueryAt, plainText, rebaseMentions, type PickedMention } from "@/lib/chat-format";
import {
  ATTACHMENT_ACCEPT,
  CHAT_FILES_BUCKET,
  CHAT_FILES_HINT,
  CHAT_MAX_FILES,
  checkAttachmentFile,
  formatBytes,
} from "@/lib/chat-files-rules";
import { mintUploads, searchChannelPeople } from "@/app/chat/actions";
import { Avatar } from "./avatar";
import { EmojiGrid, Popover } from "./popover";
import { tracked } from "./api";
import { OFFLINE, enterSends, imeComposing, resultError, senderName } from "./util";
import type { ChatPerson, UiMessage } from "./types";

type Staged = { key: string; path: string | null; name: string; size: number; type: string; progress: "uploading" | "done" | "error"; error?: string };

/** How many people the "@" list is preloaded with (lib/chat.ts MEMBER_LIST_MAX); past that, ask the server. */
const PRELOADED_MAX = 300;
const OPTIONS_MAX = 8;

/**
 * The composer. Enter sends, Shift+Enter is a newline (on a touch keyboard,
 * Enter is the newline and the Send button sends), ↑ in an empty box edits
 * your last message, Escape drops a reply. "@" offers the people who can read
 * the channel — the preloaded list at once, the server's matches as you type
 * — and the box shows "@Maya Chen" while the message stores <@id>. Files go
 * straight to private storage on a one-shot URL before the message is sent
 * (lib/chat-files-rules.ts), by picker, paste or drop; each conversation
 * keeps its own staged files and draft while the page is open.
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
  selfId,
  onPeople,
  inputId = "chat-composer",
  about = null,
  onClearAbout,
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
  /** Who the "@" menu offers first (everyone but you). */
  candidates: ChatPerson[];
  onSend: (input: { body: string; replyTo: UiMessage | null; attachments: { path: string; name: string; size: number; type: string }[] }) => void;
  onTyping: () => void;
  onEditLast: () => void;
  canMentionEveryone: boolean;
  /** Drafts are kept per channel while the page is open. */
  draftKey: string;
  /** The viewer, who never mentions themselves. */
  selfId: string;
  /**
   * Someone picked from the "@" menu who isn't in `people` yet (the server's
   * search found them): the message names them, sending and sent.
   */
  onPeople?: (more: Record<string, ChatPerson>) => void;
  /** The textarea's id: the channel's composer, or a thread's (both can be on screen). */
  inputId?: string;
  /**
   * "Ask about this": the lesson or assignment the next message links to,
   * shown as a chip that can be taken off. The caller sends it.
   */
  about?: AboutChip | null;
  onClearAbout?: () => void;
}) {
  const [text, setText] = useState("");
  const [picked, setPicked] = useState<PickedMention[]>([]);
  const [filesBy, setFilesBy] = useState<Record<string, Staged[]>>({});
  const [fileError, setFileError] = useState<{ key: string; text: string } | null>(null);
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [found, setFound] = useState<{ channelId: string; q: string; people: ChatPerson[] } | null>(null);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [wait, setWait] = useState(slowmodeWait);
  const [dragging, setDragging] = useState(false);
  // Known only in the browser; the server render assumes a keyboard.
  const [enterIsSend, setEnterIsSend] = useState(true);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const emojiRef = useRef<HTMLButtonElement>(null);
  const drafts = useRef(new Map<string, { text: string; picked: PickedMention[] }>());
  const currentKey = useRef(draftKey);
  const filesByRef = useRef(filesBy);
  filesByRef.current = filesBy;
  const searchSeq = useRef(0);
  const ids = useId();
  const listId = `${ids}-mentions`;

  const files = filesBy[draftKey] ?? [];
  const setFilesFor = useCallback((key: string, fn: (list: Staged[]) => Staged[]) => {
    setFilesBy((all) => {
      const cur = all[key] ?? [];
      const next = fn(cur);
      return next === cur ? all : { ...all, [key]: next };
    });
  }, []);
  /** An error for the conversation it happened in: an upload that fails after a switch doesn't land under another one. */
  const errorFor = (key: string, message: string | null) =>
    setFileError((cur) => (message ? { key, text: message } : cur?.key === key ? null : cur));

  useEffect(() => setEnterIsSend(enterSends()), []);

  // Switching channels stashes this draft and restores that one's (staged
  // files stay with their conversation in filesBy).
  useEffect(() => {
    if (currentKey.current !== draftKey) {
      drafts.current.set(currentKey.current, { text, picked });
      const next = drafts.current.get(draftKey);
      setText(next?.text ?? "");
      setPicked(next?.picked ?? []);
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

  // Past the preloaded list, ask the server as the name is typed.
  const searchServer = !!channelId && candidates.length + 1 >= PRELOADED_MAX;
  useEffect(() => {
    const q = mention?.query.trim() ?? "";
    if (!searchServer || !channelId || !q) return;
    const n = ++searchSeq.current;
    const t = setTimeout(async () => {
      try {
        const list = await tracked(searchChannelPeople(channelId, q));
        if (n === searchSeq.current) setFound({ channelId, q, people: list });
      } catch {
        /* the preloaded list still answers */
      }
    }, 200);
    return () => clearTimeout(t);
  }, [mention?.query, channelId, searchServer]);

  const options = useMemo(() => {
    if (!mention) return [];
    const q = mention.query.toLowerCase();
    const list: { id: string; name: string; label: string; person?: ChatPerson }[] = [];
    if (canMentionEveryone) {
      for (const v of ["everyone", "here"]) if (v.startsWith(q)) list.push({ id: `@${v}`, name: v, label: `@${v}` });
    }
    const seen = new Set<string>();
    const offer = (p: ChatPerson) => {
      if (list.length >= OPTIONS_MAX || seen.has(p.id) || (q && !p.name.toLowerCase().includes(q))) return;
      seen.add(p.id);
      list.push({ id: p.id, name: p.name, label: p.name, person: p });
    };
    for (const p of candidates) offer(p);
    // The server's matches for what's typed so far (or for the start of it).
    if (found && found.channelId === channelId && q.startsWith(found.q.toLowerCase())) {
      for (const p of found.people) if (p.id !== selfId) offer(p);
    }
    return list;
  }, [mention, candidates, canMentionEveryone, found, selfId, channelId]);

  useEffect(() => setMentionIndex(0), [mention?.query]);

  const disabled = !!disabledReason;
  const uploading = files.some((f) => f.progress === "uploading");
  const ready = files.filter((f) => f.progress === "done" && f.path);
  // What the server will measure: each picked "@Name" is a 39-character <@id> by then.
  const length = useMemo(() => composeMessage(text, picked).length, [text, picked]);
  const over = length > MESSAGE_MAX;
  const canSend = !disabled && !uploading && wait === 0 && !over && (text.trim().length > 0 || ready.length > 0);

  const submit = useCallback(() => {
    if (!canSend) return;
    onSend({
      body: composeMessage(text, picked),
      replyTo,
      attachments: ready.map((f) => ({ path: f.path!, name: f.name, size: f.size, type: f.type })),
    });
    setText("");
    setPicked([]);
    setFilesFor(draftKey, () => []);
    setMention(null);
    drafts.current.delete(draftKey);
    onCancelReply();
    // Start the countdown now; otherwise the next message goes up looking
    // sent and comes back refused by slow mode.
    if (slowmodeSeconds > 0) setWait(slowmodeSeconds);
  }, [canSend, text, picked, onSend, replyTo, ready, draftKey, onCancelReply, slowmodeSeconds, setFilesFor]);

  /** Replace the text, keeping each picked mention pinned to its "@Name". */
  const edit = (next: string, caret?: number) => {
    setPicked((p) => rebaseMentions(text, next, p, caret));
    setText(next);
  };

  const choose = (opt: { id: string; name: string; person?: ChatPerson }) => {
    if (!mention) return;
    if (opt.person && !people[opt.person.id]) onPeople?.({ [opt.person.id]: opt.person });
    const insert = `@${opt.name} `;
    const before = text.slice(0, mention.start);
    const after = text.slice(mention.start + 1 + mention.query.length);
    const next = before + insert + after;
    const pos = before.length + insert.length;
    const rebased = rebaseMentions(text, next, picked, pos);
    setText(next);
    setPicked(opt.id.startsWith("@") ? rebased : [...rebased, { id: opt.id, name: opt.name, start: mention.start }]);
    setMention(null);
    requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
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
    // Everything below belongs to the conversation this started in, even if
    // the person switches away while it uploads.
    const key = draftKey;
    errorFor(key, null);
    if (!channelId) {
      errorFor(key, "Send a first message, then you can attach files here.");
      return;
    }
    const room = CHAT_MAX_FILES - (filesByRef.current[key] ?? []).length;
    if (room <= 0) {
      errorFor(key, `Up to ${CHAT_MAX_FILES} files on one message.`);
      return;
    }
    const picks = list.slice(0, room);
    for (const f of picks) {
      const problem = checkAttachmentFile({ name: f.name, size: f.size });
      if (problem) {
        errorFor(key, problem);
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
    const mine = new Set(staged.map((s) => s.key));
    setFilesFor(key, (prev) => [...prev, ...staged]);
    const failAll = (why: string) =>
      setFilesFor(key, (prev) => prev.map((f) => (mine.has(f.key) ? { ...f, progress: "error", error: why } : f)));
    const minted = await tracked(
      mintUploads(
        channelId,
        picks.map((f) => ({ name: f.name, size: f.size, type: f.type })),
      ),
    ).catch(() => ({ ok: false as const, error: OFFLINE }));
    if (!minted.ok || !minted.data) {
      setFilesFor(key, (prev) => prev.filter((f) => !mine.has(f.key)));
      errorFor(key, resultError(minted, "Couldn't upload that file."));
      return;
    }
    let bucket;
    try {
      const { createClient } = await import("@/lib/supabase/client");
      bucket = createClient().storage.from(CHAT_FILES_BUCKET);
    } catch {
      failAll("Upload failed");
      return;
    }
    await Promise.all(
      minted.data.uploads.map(async (u, i) => {
        const k = staged[i]?.key;
        if (!k) return;
        let failed = false;
        try {
          const { error } = await bucket.uploadToSignedUrl(u.path, u.token, picks[i], {
            contentType: picks[i].type || undefined,
          });
          failed = !!error;
        } catch {
          failed = true;
        }
        // A chip removed meanwhile stays removed.
        setFilesFor(key, (prev) =>
          prev.map((f) =>
            f.key === k ? (failed ? { ...f, progress: "error", error: "Upload failed" } : { ...f, path: u.path, progress: "done" }) : f,
          ),
        );
      }),
    );
  };

  const shownError = fileError?.key === draftKey ? fileError.text : null;
  const highlighted = mention && options.length > 0 ? options[Math.min(mentionIndex, options.length - 1)] : null;
  const optionId = (i: number) => `${ids}-option-${i}`;

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
        <div
          id={listId}
          role="listbox"
          aria-label="People to mention"
          className="absolute bottom-full left-3 right-3 z-20 mb-1 max-h-72 overflow-y-auto rounded-md border border-line bg-paper p-1 shadow-[0_8px_24px_rgb(0_0_0/0.12)] md:left-5 md:right-5"
        >
          <p className="px-2 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint" aria-hidden>
            Mention
          </p>
          {options.map((o, i) => (
            <div
              key={o.id}
              id={optionId(i)}
              role="option"
              aria-selected={i === mentionIndex}
              onMouseDown={(e) => {
                e.preventDefault();
                choose(o);
              }}
              className={`flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left text-sm ${i === mentionIndex ? "bg-wash" : "hover:bg-wash"}`}
            >
              {o.person ? <Avatar name={o.person.name} size={22} /> : <span aria-hidden className="inline-flex h-[22px] w-[22px] items-center justify-center rounded-md border border-line font-mono text-[11px]">@</span>}
              <span className="min-w-0 truncate text-ink">{o.label}</span>
              {o.person?.roleLabel ? <span className="ml-auto shrink-0 font-mono text-[10px] text-ink-faint">{o.person.roleLabel}</span> : null}
              {o.id === "@everyone" ? <span className="ml-auto shrink-0 text-[11px] text-ink-faint">Pings everyone here</span> : null}
            </div>
          ))}
        </div>
      ) : null}
      <span className="sr-only" aria-live="polite">
        {mention && options.length > 0
          ? `${options.length} ${options.length === 1 ? "person" : "people"} to mention. Up and down to choose, Enter to pick.`
          : ""}
      </span>

      <div
        className={`rounded-md border bg-paper ${dragging ? "border-phosphor ring-2 ring-phosphor/40" : "border-line focus-within:border-ink/40"} ${disabled ? "opacity-70" : ""}`}
      >
        {about ? (
          <div className="flex items-center gap-2 border-b border-line px-3 py-1.5 text-xs text-ink-soft">
            <BookOpen className="h-3.5 w-3.5 shrink-0" aria-hidden />
            <span className="min-w-0 flex-1 truncate">
              Asking about the {about.kind === "lesson" ? "lesson" : "assignment"} <strong className="text-ink">{about.title}</strong>
              <span className="ml-2 text-ink-faint">Only people who can open it see which one.</span>
            </span>
            {onClearAbout ? (
              <button type="button" onClick={onClearAbout} aria-label="Don't link it" className="rounded p-0.5 hover:bg-wash">
                <X className="h-3.5 w-3.5" />
              </button>
            ) : null}
          </div>
        ) : null}
        {replyTo ? (
          <div className="flex items-center gap-2 border-b border-line px-3 py-1.5 text-xs text-ink-soft">
            <span className="min-w-0 flex-1 truncate">
              Replying to <strong className="text-ink">{senderName(replyTo, people)}</strong>
              <span className="ml-2 text-ink-faint">{plainText(replyTo.body || "[attachment]", (id) => people[id]?.name, () => null, 80)}</span>
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
                className={`inline-flex min-w-0 max-w-[14rem] items-center gap-2 rounded-md border px-2 py-1 text-xs ${f.progress === "error" ? "border-red-500/50 text-red-600 dark:text-red-400" : "border-line text-ink-soft"}`}
              >
                {f.progress === "uploading" ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" aria-label="Uploading" /> : <FileText className="h-3.5 w-3.5 shrink-0" />}
                <span className="min-w-0 truncate">{f.name}</span>
                <span className="shrink-0 font-mono text-[10px] text-ink-faint">{f.error ?? formatBytes(f.size)}</span>
                <button
                  type="button"
                  onClick={() => setFilesFor(draftKey, (prev) => prev.filter((x) => x.key !== f.key))}
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
          <label htmlFor={inputId} className="sr-only">
            {placeholder}
          </label>
          <textarea
            id={inputId}
            ref={ref}
            value={text}
            disabled={disabled}
            rows={1}
            placeholder={disabledReason ?? placeholder}
            aria-autocomplete="list"
            aria-controls={mention && options.length > 0 ? listId : undefined}
            aria-activedescendant={highlighted ? optionId(Math.min(mentionIndex, options.length - 1)) : undefined}
            enterKeyHint={enterIsSend ? "send" : "enter"}
            onChange={(e) => {
              const caret = e.target.selectionEnd ?? e.target.value.length;
              edit(e.target.value, caret);
              updateMention(e.target.value, caret);
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
                  choose(options[Math.min(mentionIndex, options.length - 1)]);
                  return;
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  setMention(null);
                  return;
                }
              }
              if (e.key === "Enter" && !e.shiftKey && enterIsSend) {
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
            className="max-h-[40vh] min-h-[36px] flex-1 resize-none bg-transparent px-1.5 py-2 text-base leading-snug text-ink placeholder:text-ink-faint focus:outline-none disabled:cursor-not-allowed md:text-[15px]"
          />
          <div className="relative">
            <button
              ref={emojiRef}
              type="button"
              disabled={disabled}
              onClick={() => setEmojiOpen((o) => !o)}
              aria-label="Insert emoji"
              aria-haspopup="true"
              aria-expanded={emojiOpen}
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-ink-faint hover:bg-wash hover:text-ink disabled:opacity-40"
            >
              <SmilePlus className="h-4 w-4" />
            </button>
            <Popover open={emojiOpen} onClose={() => setEmojiOpen(false)} toggleRef={emojiRef} className="bottom-11 right-0">
              <EmojiGrid
                label="Insert an emoji"
                onPick={(emoji) => {
                  const el = ref.current;
                  const at = el?.selectionStart ?? text.length;
                  edit(text.slice(0, at) + emoji + text.slice(at), at + emoji.length);
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
        <span className="flex min-w-0 items-center gap-1">
          {shownError ? (
            <span role="alert" className="inline-flex min-w-0 items-center gap-1 text-red-600 dark:text-red-400">
              <span className="min-w-0 truncate">{shownError}</span>
              <button type="button" onClick={() => errorFor(draftKey, null)} aria-label="Dismiss" className="shrink-0 rounded hover:bg-wash">
                <X className="h-3 w-3" />
              </button>
            </span>
          ) : wait > 0 ? (
            <span className="truncate">Slow mode: you can post again in {wait}s</span>
          ) : null}
        </span>
        {length > MESSAGE_MAX - 400 ? (
          <span className={`shrink-0 font-mono ${over ? "text-red-600 dark:text-red-400" : ""}`} aria-live="polite">
            {(MESSAGE_MAX - length).toLocaleString()}
          </span>
        ) : !disabled ? (
          // Truncated, not overflowing, when a side pane narrows the column.
          <span className="hidden min-w-0 truncate lg:inline">
            **bold** *italic* `code` ||spoiler|| · Shift+Enter for a new line
          </span>
        ) : null}
      </div>
    </div>
  );
}
