"use client";
import { useState } from "react";
import { ArrowBigUp, Check, RotateCcw, Sparkles, X } from "lucide-react";
import { LocalTime } from "@/components/ui/local-time";
import { normalizeQuestion, MAX_QUESTION_LENGTH } from "@/lib/live";
import type { RoomQuestion } from "@/lib/webinars";
import type { OutboxItem } from "./use-outbox";
import { Chip, Closed, Composer, Empty, RowAction, ROW_ACTIONS } from "./ui";

export function QaTab({
  questions,
  outbox,
  isHost,
  canUpvote,
  needsApproval,
  closed,
  onAsk,
  onRetry,
  onDiscard,
  onVote,
  onSpotlight,
  onApprove,
  onStatus,
}: {
  /** Already in queue order (sortQuestions). */
  questions: RoomQuestion[];
  outbox: OutboxItem[];
  isHost: boolean;
  /** Upvotes exist only where the audience sees each other's questions. */
  canUpvote: boolean;
  /** Moderated room: a question waits for a host before the room sees it. */
  needsApproval: boolean;
  closed: boolean;
  onAsk: (body: string) => void;
  onRetry: (id: string) => void;
  onDiscard: (id: string) => void;
  onVote: (id: string, on: boolean) => void;
  onSpotlight: (id: string, on: boolean) => void;
  onApprove: (id: string) => void;
  onStatus: (id: string, status: RoomQuestion["status"]) => void;
}) {
  const [draft, setDraft] = useState("");
  const stored = new Set(questions.map((q) => q.id));
  const pending = outbox.filter((o) => !stored.has(o.id));

  const submit = () => {
    if (!normalizeQuestion(draft)) return;
    onAsk(draft);
    setDraft("");
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto py-2">
        {questions.length === 0 && pending.length === 0 ? (
          <Empty>No questions yet.</Empty>
        ) : (
          <ul className="space-y-1">
            {questions.map((q) => (
              <li
                key={q.id}
                data-question-id={q.id}
                className={`group mx-2 flex gap-2 rounded-md px-2 py-2 ${
                  q.spotlighted ? "bg-phosphor/15" : q.status === "open" ? "hover:bg-ink/5" : "opacity-60"
                }`}
              >
                {canUpvote && (
                  <button
                    type="button"
                    disabled={q.mine || isHost || closed || q.status !== "open"}
                    onClick={() => onVote(q.id, !q.voted)}
                    aria-pressed={q.voted}
                    aria-label={q.voted ? "Remove upvote" : "Upvote"}
                    className={`flex h-11 w-9 shrink-0 flex-col items-center justify-center rounded-md border text-[11px] tabular-nums transition disabled:cursor-default ${
                      q.voted
                        ? "border-phosphor/60 bg-phosphor/15 text-phosphor-ink"
                        : "border-line text-ink-faint enabled:hover:text-ink"
                    }`}
                  >
                    <ArrowBigUp className="h-4 w-4" />
                    {q.voteCount}
                  </button>
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex min-h-7 items-center gap-2 text-xs">
                    <span className="truncate font-semibold text-ink">{q.askerName}</span>
                    <LocalTime value={q.createdAt} mode="time" className="shrink-0 text-ink-faint" />
                    {q.spotlighted && <Chip tone="accent">Spotlight</Chip>}
                    {q.status === "answered" && <Chip>Answered</Chip>}
                    {q.status === "dismissed" && <Chip>Dismissed</Chip>}
                    {needsApproval && !q.approvedAt && q.status === "open" && <Chip>Pending</Chip>}
                    {isHost && (
                      <div className={`ml-auto ${ROW_ACTIONS}`}>
                        {needsApproval && !q.approvedAt && q.status === "open" && (
                          <RowAction label="Approve" onClick={() => onApprove(q.id)}>
                            <Check className="h-3.5 w-3.5" />
                          </RowAction>
                        )}
                        <RowAction
                          label={q.spotlighted ? "Unspotlight" : "Spotlight"}
                          onClick={() => onSpotlight(q.id, !q.spotlighted)}
                        >
                          <Sparkles className="h-3.5 w-3.5" />
                        </RowAction>
                        {q.status === "open" ? (
                          <>
                            <RowAction label="Answered" onClick={() => onStatus(q.id, "answered")}>
                              <Check className="h-3.5 w-3.5" />
                            </RowAction>
                            <RowAction label="Dismiss" onClick={() => onStatus(q.id, "dismissed")}>
                              <X className="h-3.5 w-3.5" />
                            </RowAction>
                          </>
                        ) : (
                          <RowAction label="Back to the queue" onClick={() => onStatus(q.id, "open")}>
                            <RotateCcw className="h-3.5 w-3.5" />
                          </RowAction>
                        )}
                      </div>
                    )}
                  </div>
                  <p className="whitespace-pre-wrap break-words text-sm text-ink">{q.body}</p>
                </div>
              </li>
            ))}
            {pending.map((o) => (
              <li key={o.id} className="mx-2 px-2 py-2" data-outbox={o.state}>
                <p className="flex items-center gap-2 text-xs text-ink-faint">
                  <span className="font-semibold text-ink">You</span>
                  {o.state === "sending" ? (
                    <span>Sending…</span>
                  ) : (
                    <>
                      <span className="text-red-500">Not sent{o.error ? ` · ${o.error}` : ""}</span>
                      <RowAction label="Retry" onClick={() => onRetry(o.id)}>
                        <RotateCcw className="h-3.5 w-3.5" />
                      </RowAction>
                      <RowAction label="Discard" onClick={() => onDiscard(o.id)}>
                        <X className="h-3.5 w-3.5" />
                      </RowAction>
                    </>
                  )}
                </p>
                <p className="whitespace-pre-wrap break-words text-sm text-ink opacity-70">{o.body}</p>
              </li>
            ))}
          </ul>
        )}
      </div>

      {isHost ? null : closed ? (
        <Closed>Q&amp;A closed.</Closed>
      ) : (
        <Composer
          value={draft}
          onChange={setDraft}
          onSubmit={submit}
          canSubmit={!!normalizeQuestion(draft)}
          placeholder="Ask a question"
          label="Your question"
          maxLength={MAX_QUESTION_LENGTH}
        />
      )}
    </div>
  );
}
