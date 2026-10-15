"use client";
import { useState, useTransition } from "react";
import { Send } from "lucide-react";
import { broadcastAnnouncement } from "@/app/admin/announcements/actions";
import { getActionError } from "@/lib/action-error";

export type CohortOption = { id: string; name: string };

/**
 * Send an announcement from a phone.
 *
 * This is the other admin job that is genuinely time-sensitive — "office hours
 * moved", "demo day link changed" — and it calls the same
 * `broadcastAnnouncement` action as the desktop composer, so it persists the
 * row, fans out in-app notifications, optionally emails every enrolled student,
 * optionally posts it in Chat (#announcements, or the cohort's own channel
 * for a one-cohort announcement), and writes the audit entry.
 *
 * Three deliberate choices about the blast radius:
 *
 *   Email defaults OFF. The action emails recipients in a sequential loop; a
 *   mis-tap here is an inbox for every student in the program and cannot be
 *   recalled. The chat post defaults ON because a chat message can be
 *   deleted.
 *
 *   @everyone defaults OFF and is only offered with the chat post. It
 *   notifies everyone who can read the channel it lands in.
 *
 *   Send takes a confirmation tap, and the button says exactly who it reaches.
 *   The recipient count comes back from the action afterwards, so the label is
 *   the audience, not a number we'd have to fetch to be honest about.
 */
export function AnnounceForm({ cohorts }: { cohorts: CohortOption[] }) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [cohortId, setCohortId] = useState<string>("");
  const [email, setEmail] = useState(false);
  const [chat, setChat] = useState(true);
  const [pingEveryone, setPingEveryone] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<{
    recipients: number;
    chat: boolean;
    chatError: string | null;
  } | null>(null);
  const [pending, startTransition] = useTransition();

  const ready = !!title.trim() && !!body.trim();
  const audience = cohortId
    ? (cohorts.find((c) => c.id === cohortId)?.name ?? "that cohort")
    : "every enrolled student";

  function send() {
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setError(null);
    setConfirming(false);
    startTransition(async () => {
      try {
        const res = await broadcastAnnouncement({
          cohortId: cohortId || null,
          title,
          body,
          sendEmail: email,
          postChat: chat,
          mentionEveryone: chat && pingEveryone,
        });
        setSent({
          recipients: res.recipients,
          chat: res.chatPosted,
          chatError: res.chatError,
        });
        setTitle("");
        setBody("");
      } catch (e) {
        setError(getActionError(e));
      }
    });
  }

  if (sent) {
    return (
      <div className="rounded-2xl border border-emerald-500/30 bg-emerald-500/10 px-5 py-4">
        <p className="text-[14px] font-medium text-emerald-700 dark:text-emerald-300">
          Sent to {sent.recipients} student{sent.recipients === 1 ? "" : "s"}.
        </p>
        <p className="mt-1 text-[12px] text-ink-soft">
          {sent.chat
            ? cohortId
              ? "Posted in the cohort's channel too."
              : "Posted in #announcements too."
            : chat
              ? `The chat post didn't go through${
                  sent.chatError ? ` (${sent.chatError})` : ""
                }.`
              : "In-app only."}
        </p>
        <button
          type="button"
          onClick={() => setSent(null)}
          className="press mt-3 text-[13px] text-phosphor-ink underline"
        >
          Write another
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-3.5">
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Title"
        className="h-11 w-full rounded-xl border border-line bg-wash px-3.5 text-[15px] text-ink placeholder:text-ink-faint focus:border-phosphor focus:outline-none focus:ring-1 focus:ring-phosphor"
      />
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={4}
        placeholder="What's happening?"
        className="block w-full resize-y rounded-xl border border-line bg-wash px-3.5 py-3 text-[15px] leading-relaxed text-ink placeholder:text-ink-faint focus:border-phosphor focus:outline-none focus:ring-1 focus:ring-phosphor"
      />

      <label className="block">
        <span className="font-mono text-[10px] font-medium uppercase tracking-[0.22em] text-ink-faint">
          Audience
        </span>
        <select
          value={cohortId}
          onChange={(e) => setCohortId(e.target.value)}
          className="mt-2 h-11 w-full rounded-xl border border-line bg-wash px-3 text-[15px] text-ink focus:border-phosphor focus:outline-none focus:ring-1 focus:ring-phosphor"
        >
          <option value="">Everyone enrolled</option>
          {cohorts.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>

      <div className="space-y-2">
        <Toggle
          checked={chat}
          onChange={setChat}
          label={cohortId ? "Also post in the cohort's channel" : "Also post in #announcements"}
          hint={cohortId ? "Only that cohort and staff read it in Chat." : "Everyone at batch0 can read it in Chat."}
        />
        {chat && (
          <Toggle
            checked={pingEveryone}
            onChange={setPingEveryone}
            label="Notify everyone (@everyone)"
            hint="Pings everyone who can read the channel."
            tone="warn"
          />
        )}
        <Toggle
          checked={email}
          onChange={setEmail}
          label="Also email everyone"
          hint="One email per recipient. Can't be unsent."
          tone="warn"
        />
      </div>

      {error && (
        <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3.5 py-2.5 text-[13px] text-red-600 dark:text-red-300">
          {error}
        </p>
      )}

      <button
        type="button"
        onClick={send}
        disabled={!ready || pending}
        aria-busy={pending}
        className="press inline-flex h-11 w-full select-none items-center justify-center gap-2 rounded-md bg-phosphor text-[14px] font-semibold leading-none text-on-phosphor shadow-cta active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 disabled:active:scale-100"
      >
        <Send className="h-4 w-4" />
        {pending
          ? "Sending…"
          : confirming
            ? `Send to ${audience}?`
            : "Send announcement"}
      </button>
      {confirming && (
        <p className="text-center text-[11px] leading-relaxed text-ink-faint">
          Tap again to send to {audience}
          {email ? ", including email" : ""}
          {chat ? (cohortId ? ", posting in the cohort's channel" : ", posting in #announcements") : ""}
          {chat && pingEveryone ? " and pinging @everyone" : ""}.
        </p>
      )}
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  label,
  hint,
  tone = "default",
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint: string;
  tone?: "default" | "warn";
}) {
  const on =
    tone === "warn"
      ? "border-amber-500/40 bg-amber-500/10"
      : "border-phosphor/40 bg-phosphor/[0.08]";
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`press flex w-full items-center gap-3 rounded-xl border px-4 py-3 text-left active:scale-[0.99] ${
        checked ? on : "border-line bg-wash"
      }`}
    >
      <span className="min-w-0 flex-1">
        <span className="block text-[14px] leading-tight text-ink">{label}</span>
        <span className="mt-1 block text-[12px] leading-snug text-ink-soft">
          {hint}
        </span>
      </span>
      <span
        className={`relative h-6 w-10 shrink-0 rounded-full transition-colors ${
          checked ? "bg-phosphor" : "bg-line"
        }`}
      >
        <span
          className={`absolute top-0.5 h-5 w-5 rounded-full bg-paper transition-[left] ${
            checked ? "left-[18px]" : "left-0.5"
          }`}
        />
      </span>
    </button>
  );
}
