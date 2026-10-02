"use client";
import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Textarea, FieldError } from "@/components/ui/input";
import { AttachmentPicker } from "@/components/support/attachment-picker";
import { getActionError } from "@/lib/action-error";
import type { RejectedAttachment } from "@/lib/support-attachment-rules";
import {
  OUTCOME_LABELS,
  REPLY_BODY_MAX,
  TICKET_OUTCOMES,
  type TicketStatus,
} from "@/lib/support-access";
import { replyAsStaff, type StaffReplyMode } from "@/app/admin/support/actions";

/**
 * The team's composer: a reply, a reply that also resolves the request
 * ("Send & resolve", with an optional outcome), or an internal note — each
 * with files, uploaded through the staff-scoped picker.
 *
 * Separate from the requester's composer in components/support/ticket-thread
 * because the two differ in exactly the things that matter here: the
 * resolve step, the outcome, and a note mode that must never email anyone.
 *
 * "Internal note" stays ticked after a note is saved. The opposite default is
 * the dangerous one: a second note typed into a box that silently went back
 * to "reply" would be emailed to the person it's about. Left ticked, the
 * worst case is a reply saved as a note — which stays in the queue as still
 * owing them an answer, where someone will see it.
 */

/** "No response" is the cron's verdict on silence, not something a reply can be. */
const RESOLVE_OUTCOMES = TICKET_OUTCOMES.filter((o) => o !== "no_response");

export function StaffComposer({
  ticketId,
  status,
}: {
  ticketId: string;
  status: TicketStatus;
}) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [body, setBody] = useState("");
  const [internal, setInternal] = useState(false);
  const [outcome, setOutcome] = useState("");
  const [uploading, setUploading] = useState(false);
  const [resetKey, setResetKey] = useState(0);
  const [sending, setSending] = useState<StaffReplyMode | null>(null);
  const [err, setErr] = useState<string | undefined>();
  const [rejected, setRejected] = useState<RejectedAttachment[]>([]);
  const [announcement, setAnnouncement] = useState("");
  const [pending, start] = useTransition();

  // Resolving only means something while the request is live. On a resolved
  // or closed one, a reply leaves the status where it is.
  const canResolve = status === "open" || status === "waiting_on_requester";
  // Held while a file is still uploading: a message sent mid-upload goes
  // without the file the sender thinks is on it.
  const blocked = pending || uploading || !body.trim();

  function send(mode: StaffReplyMode) {
    const text = body.trim();
    if (!text) return;
    setErr(undefined);
    setRejected([]);
    setAnnouncement("");
    setSending(mode);
    // The picker's hidden input: the files that finished uploading, as JSON.
    const staged = formRef.current ? new FormData(formRef.current).get("attachments") : null;
    start(async () => {
      try {
        const res = await replyAsStaff({
          ticketId,
          body: text,
          mode,
          outcome: mode === "reply_resolve" && outcome ? outcome : null,
          attachments: typeof staged === "string" ? staged : null,
        });
        if (!res.ok) {
          setErr(res.error);
          return;
        }
        setBody("");
        setOutcome("");
        setResetKey((k) => k + 1);
        setRejected(res.data?.rejected ?? []);
        setAnnouncement(
          mode === "note"
            ? "Note saved."
            : mode === "reply_resolve"
              ? "Reply sent and the request resolved."
              : "Reply sent.",
        );
        router.refresh();
      } catch (e) {
        setErr(getActionError(e));
      }
    });
  }

  const label = (mode: StaffReplyMode, idle: string, busy: string) =>
    pending && sending === mode ? busy : idle;

  return (
    <form ref={formRef} onSubmit={(e) => e.preventDefault()} className="mt-6">
      <label htmlFor="staff-reply" className="sr-only">
        {internal ? "Internal note" : "Reply to the requester"}
      </label>
      <Textarea
        id="staff-reply"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        // ⌘/Ctrl+Enter is the plain send — a reply, or a note when "Internal
        // note" is ticked. Never Send & resolve: closing someone's request
        // takes the button.
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            if (!blocked) send(internal ? "note" : "reply");
          }
        }}
        placeholder={
          internal
            ? "A note for the team. The requester never sees this."
            : "Reply to the requester. This emails them."
        }
        maxLength={REPLY_BODY_MAX}
        rows={5}
        error={err}
      />
      <FieldError id="staff-reply-error">{err}</FieldError>

      <div className="mt-3">
        <AttachmentPicker
          scope={{ kind: "staff", ticketId }}
          name="attachments"
          disabled={pending}
          onBusyChange={setUploading}
          resetKey={resetKey}
        />
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        {/* A checkbox rather than a third button: whether this emails a real
            person should be visible while the message is being typed, not
            decided at the last click. */}
        <label className="flex cursor-pointer select-none items-center gap-1.5 text-xs text-ink-soft">
          <input
            type="checkbox"
            checked={internal}
            disabled={pending}
            onChange={(e) => setInternal(e.target.checked)}
            className="h-3.5 w-3.5 accent-amber-500"
          />
          Internal note
        </label>

        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
          {internal ? (
            <Button size="sm" onClick={() => send("note")} disabled={blocked}>
              {label("note", "Save note", "Saving…")}
            </Button>
          ) : (
            <>
              {canResolve && (
                <div className="flex items-center gap-2">
                  <label className="flex items-center gap-1.5 text-xs text-ink-soft">
                    Resolve as
                    <select
                      value={outcome}
                      disabled={pending}
                      onChange={(e) => setOutcome(e.target.value)}
                      className="h-8 rounded-md border border-line bg-paper px-2 text-xs text-ink focus:border-phosphor focus:outline-none focus:ring-2 focus:ring-phosphor/30 disabled:opacity-50"
                    >
                      <option value="">No outcome</option>
                      {RESOLVE_OUTCOMES.map((o) => (
                        <option key={o} value={o}>
                          {OUTCOME_LABELS[o]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => send("reply_resolve")}
                    disabled={blocked}
                  >
                    {label("reply_resolve", "Send & resolve", "Sending…")}
                  </Button>
                </div>
              )}
              <Button size="sm" onClick={() => send("reply")} disabled={blocked}>
                {label("reply", "Send reply", "Sending…")}
              </Button>
            </>
          )}
        </div>
      </div>

      <p className="mt-2 text-xs text-ink-faint">
        {uploading
          ? "Waiting for the files to finish uploading…"
          : internal
            ? "Only the team sees notes and their files. A note doesn't move the request."
            : canResolve
              ? "Send reply emails them and moves this out of the queue. Send & resolve also marks it resolved, in the same email."
              : status === "closed"
                ? "This request is closed. A reply still emails them, and it stays closed."
                : "A reply emails them, and the request stays resolved."}
      </p>

      {rejected.length > 0 && (
        <div
          role="alert"
          className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200"
        >
          <p className="font-medium">
            {sending === "note" ? "Saved" : "Sent"}, but{" "}
            {rejected.length === 1 ? "one file" : `${rejected.length} files`}{" "}
            didn&rsquo;t attach. Add {rejected.length === 1 ? "it" : "them"} to a new
            message:
          </p>
          <ul className="mt-1 list-disc space-y-0.5 pl-4">
            {rejected.map((r, i) => (
              <li key={i}>
                <span className="break-all">{r.name}</span> — {r.reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>
    </form>
  );
}
