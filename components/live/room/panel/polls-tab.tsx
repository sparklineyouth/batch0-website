"use client";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  normalizePoll,
  pollPercentages,
  MAX_POLL_OPTIONS,
  MAX_POLL_OPTION_LENGTH,
  MAX_POLL_QUESTION_LENGTH,
  type WebinarPoll,
} from "@/lib/webinars";
import type { PanelWrite } from "@/lib/webinar-panel";
import { Chip, Empty, FIELD, RowAction } from "./ui";

/** A poll being written. Held by the panel, so a tab switch keeps it (and a save in flight). */
export type PollDraft = {
  question: string;
  options: string[];
  resultsVisible: boolean;
  saving: boolean;
};
/** Null closes the form. */
type DraftUpdate = (fn: (draft: PollDraft | null) => PollDraft | null) => void;
export type PollInput = {
  question: string;
  options: string[];
  resultsVisible: boolean;
  open: boolean;
};

const EMPTY_POLL: PollDraft = {
  question: "",
  options: ["", ""],
  resultsVisible: true,
  saving: false,
};

export function PollsTab({
  polls,
  isHost,
  closed,
  draft,
  onDraftChange,
  onVote,
  onSetOpen,
  onCreate,
}: {
  polls: WebinarPoll[];
  isHost: boolean;
  closed: boolean;
  /** Null while no poll is being written. */
  draft: PollDraft | null;
  onDraftChange: DraftUpdate;
  onVote: (pollId: string, choice: number) => void;
  onSetOpen: (pollId: string, open: boolean) => void;
  onCreate: (input: PollInput) => Promise<PanelWrite<string>>;
}) {
  // Newest first: the poll that just opened is the one people are looking for.
  const ordered = [...polls].reverse();

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-3">
      {isHost &&
        (draft ? (
          <PollForm draft={draft} onChange={onDraftChange} onCreate={onCreate} />
        ) : (
          <Button size="sm" variant="secondary" className="mb-3" onClick={() => onDraftChange(() => EMPTY_POLL)}>
            <Plus className="h-3.5 w-3.5" />
            New poll
          </Button>
        ))}
      {ordered.length === 0 ? (
        <Empty>No polls yet.</Empty>
      ) : (
        <ul className="space-y-3">
          {ordered.map((p) => (
            <PollCard
              key={p.id}
              poll={p}
              isHost={isHost}
              closed={closed}
              onVote={onVote}
              onSetOpen={onSetOpen}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function PollCard({
  poll,
  isHost,
  closed,
  onVote,
  onSetOpen,
}: {
  poll: WebinarPoll;
  isHost: boolean;
  closed: boolean;
  onVote: (pollId: string, choice: number) => void;
  onSetOpen: (pollId: string, open: boolean) => void;
}) {
  const total = poll.tally.reduce((a, b) => a + b, 0);
  // Hosts always see the numbers; the server already zeroed a hidden tally.
  const showResults = isHost || poll.resultsVisible;
  const percent = pollPercentages(poll.tally);
  const drafted = !poll.open && total === 0;
  const canVote = poll.open && !closed && !isHost;

  return (
    <li className="rounded-md border border-line bg-paper p-3" data-poll-id={poll.id}>
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-medium text-ink">{poll.question}</p>
        {poll.open ? (
          <Chip tone="accent">Live</Chip>
        ) : (
          <Chip>{isHost && drafted ? "Draft" : "Closed"}</Chip>
        )}
      </div>
      <ul className="mt-2 space-y-1.5">
        {poll.options.map((option, i) => {
          const mine = poll.myChoice === i;
          return (
            <li key={i}>
              <button
                type="button"
                disabled={!canVote}
                onClick={() => onVote(poll.id, i)}
                aria-pressed={mine}
                className={`relative w-full overflow-hidden rounded-md border px-2.5 py-1.5 text-left text-sm transition disabled:cursor-default ${
                  mine ? "border-phosphor text-ink" : "border-line text-ink enabled:hover:border-ink/40"
                }`}
              >
                {showResults && (
                  <span
                    className="absolute inset-y-0 left-0 bg-phosphor/20"
                    style={{ width: `${percent[i] ?? 0}%` }}
                    aria-hidden
                  />
                )}
                <span className="relative flex items-center justify-between gap-2">
                  <span className="min-w-0 break-words">{option}</span>
                  {showResults && (
                    <span className="shrink-0 tabular-nums text-xs text-ink-soft">{percent[i] ?? 0}%</span>
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <div className="mt-2 flex items-center justify-between gap-2 text-xs text-ink-faint">
        <span>{showResults ? `${total} vote${total === 1 ? "" : "s"}` : "Results hidden"}</span>
        {isHost && (
          <Button size="sm" variant={poll.open ? "secondary" : "primary"} onClick={() => onSetOpen(poll.id, !poll.open)}>
            {poll.open ? "Close" : drafted ? "Launch" : "Open"}
          </Button>
        )}
      </div>
    </li>
  );
}

function PollForm({
  draft,
  onChange,
  onCreate,
}: {
  draft: PollDraft;
  onChange: DraftUpdate;
  onCreate: (input: PollInput) => Promise<PanelWrite<string>>;
}) {
  const { question, options, resultsVisible, saving: busy } = draft;
  const checked = normalizePoll({ question, options });
  const touched = question.trim() !== "" || options.some((o) => o.trim() !== "");
  const edit = (patch: Partial<PollDraft>) => onChange((d) => d && { ...d, ...patch });
  const setOptions = (fn: (prev: string[]) => string[]) =>
    onChange((d) => d && { ...d, options: fn(d.options) });

  const save = async (open: boolean) => {
    if (!checked.ok || busy) return;
    edit({ saving: true });
    const res = await onCreate({
      question: checked.question,
      options: checked.options,
      resultsVisible,
      open,
    });
    if (res.ok) onChange(() => null);
    else edit({ saving: false });
  };

  const field = `h-9 w-full rounded-md border px-2.5 text-base placeholder:text-ink-faint focus:border-phosphor focus:outline-none md:text-sm ${FIELD}`;

  return (
    <div className="mb-3 space-y-2 rounded-md border border-line bg-paper p-3">
      <input
        value={question}
        onChange={(e) => edit({ question: e.target.value.slice(0, MAX_POLL_QUESTION_LENGTH) })}
        placeholder="Question"
        aria-label="Poll question"
        className={field}
      />
      {options.map((option, i) => (
        <div key={i} className="flex items-center gap-1">
          <input
            value={option}
            onChange={(e) =>
              setOptions((prev) =>
                prev.map((o, j) => (j === i ? e.target.value.slice(0, MAX_POLL_OPTION_LENGTH) : o)),
              )
            }
            placeholder={`Option ${i + 1}`}
            aria-label={`Option ${i + 1}`}
            className={field}
          />
          {options.length > 2 && (
            <RowAction
              label={`Remove option ${i + 1}`}
              onClick={() => setOptions((prev) => prev.filter((_, j) => j !== i))}
            >
              <X className="h-3.5 w-3.5" />
            </RowAction>
          )}
        </div>
      ))}
      {options.length < MAX_POLL_OPTIONS && (
        <button
          type="button"
          onClick={() => setOptions((prev) => [...prev, ""])}
          className="inline-flex items-center gap-1 text-xs text-ink-soft hover:text-ink"
        >
          <Plus className="h-3 w-3" />
          Add option
        </button>
      )}
      <label className="flex items-center gap-2 text-xs text-ink-soft">
        <input
          type="checkbox"
          checked={resultsVisible}
          onChange={(e) => edit({ resultsVisible: e.target.checked })}
          className="h-3.5 w-3.5 accent-phosphor"
        />
        Show results to everyone
      </label>
      {touched && !checked.ok && <p className="text-xs text-red-500">{checked.error}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={() => void save(true)} disabled={!checked.ok || busy}>
          Launch
        </Button>
        <Button size="sm" variant="secondary" onClick={() => void save(false)} disabled={!checked.ok || busy}>
          Save draft
        </Button>
        <Button size="sm" variant="ghost" onClick={() => onChange(() => null)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
