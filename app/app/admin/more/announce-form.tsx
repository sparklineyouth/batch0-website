"use client";
import { useState, useTransition } from "react";
import { Send } from "lucide-react";
import {
  broadcastAnnouncement,
  type AnnouncementPing,
} from "@/app/admin/announcements/actions";
import { getActionError } from "@/lib/action-error";

export type CohortOption = { id: string; name: string };

/**
 * Send an announcement from a phone.
 *
 * This is the other admin job that is genuinely time-sensitive — "office hours
 * moved", "demo day link changed" — and it calls the same
 * `broadcastAnnouncement` action as the desktop composer, so it persists the
 * row, fans out in-app notifications, optionally emails every enrolled student,
 * optionally posts to Discord, and writes the audit entry.
 *
 * Three deliberate choices about the blast radius:
 *
 *   Email defaults OFF. The action emails recipients in a sequential loop; a
 *   mis-tap here is an inbox for every student in the program and cannot be
 *   recalled. Discord defaults ON because a channel post can be deleted.
 *
 *   The ping selector only offers none/@here/@everyone. The role-ping options
 *   the desktop composer exposes need you to know which Discord role maps to
 *   which audience, which is not a thing to reason about one-handed.
 *
 *   Send takes a confirmation tap, and the button says exactly who it reaches.
 *   The recipient count comes back from the action afterwards, so the label is
 *   the audience, not a number we'd have to fetch to be honest about.
 *
 * The confirmation is a *second* control, not the same button relabelled, and
 * touching anything that changes who this reaches disarms it — see `disarm`.
 * Arming a button and then flipping "Also email everyone" under it left a
 * primed control whose blast radius had silently changed.
 */
export function AnnounceForm({ cohorts }: { cohorts: CohortOption[] }) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [cohortId, setCohortId] = useState<string>("");
  const [email, setEmail] = useState(false);
  const [discord, setDiscord] = useState(true);
  const [ping, setPing] = useState<AnnouncementPing>("none");
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<{ recipients: number; discord: boolean } | null>(
    null,
  );
  const [pending, startTransition] = useTransition();

  const ready = !!title.trim() && !!body.trim();
  const audience = cohortId
    ? (cohorts.find((c) => c.id === cohortId)?.name ?? "that cohort")
    : "every enrolled student";

  // Any change to who this reaches un-arms the confirm. Without it you could
  // arm the button, flip "Also email everyone", and the next tap would email
  // every enrolled student from a control armed for a different audience.
  function disarm() {
    setConfirming(false);
  }

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
          postDiscord: discord,
          discordPing: ping,
        });
        setSent({ recipients: res.recipients, discord: res.discordPosted });
        setTitle("");
        setBody("");
      } catch (e) {
        setError(getActionError(e));
      }
    });
  }

  /**
   * Clears everything the last send configured, not just its text.
   *
   * The reset lives here rather than in the success path on purpose. The
   * outcome card reads live `discord` to explain what happened, so clearing it
   * back to its default in the same tick as the result would make a send the
   * admin deliberately kept in-app report "Discord post didn't go through".
   *
   * It has to happen somewhere, though: the blast radius used to survive a
   * send, so the second announcement of a session silently inherited the
   * first one's email fan-out — defeating the email-OFF default above, which
   * is the whole reason that default exists.
   */
  function writeAnother() {
    setSent(null);
    setError(null);
    setCohortId("");
    setEmail(false);
    setDiscord(true);
    setPing("none");
    setConfirming(false);
  }

  return (
    <div className="space-y-3.5">
      {/* 16px on both, not 15: iOS Safari zooms the whole viewport when a
          focused field's text is under 16px and never zooms back out on blur.
          globals.css sets text-size-adjust for the neighbouring reason, but
          that does not cover focus zoom — only the font size does. The two
          <select>s below stay at 15px: a picker wheel never triggers it. */}
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Title"
        autoCapitalize="sentences"
        enterKeyHint="next"
        className="h-11 w-full rounded-xl border border-line bg-wash px-3.5 text-[16px] text-ink placeholder:text-ink-faint focus:border-phosphor focus:outline-none focus:ring-1 focus:ring-phosphor"
      />
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={4}
        placeholder="What's happening?"
        className="block w-full resize-y rounded-xl border border-line bg-wash px-3.5 py-3 text-[16px] leading-relaxed text-ink placeholder:text-ink-faint focus:border-phosphor focus:outline-none focus:ring-1 focus:ring-phosphor"
      />

      <label className="block">
        <span className="font-mono text-[10px] font-medium uppercase tracking-[0.22em] text-ink-faint">
          Audience
        </span>
        <select
          value={cohortId}
          onChange={(e) => {
            disarm();
            setCohortId(e.target.value);
          }}
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
          checked={discord}
          onChange={(v) => {
            disarm();
            setDiscord(v);
          }}
          label="Post to Discord"
          hint="Goes to the announcements channel."
        />
        <Toggle
          checked={email}
          onChange={(v) => {
            disarm();
            setEmail(v);
          }}
          label="Also email everyone"
          hint="One email per recipient. Can't be unsent."
          tone="warn"
        />
      </div>

      {discord && (
        <label className="block">
          <span className="font-mono text-[10px] font-medium uppercase tracking-[0.22em] text-ink-faint">
            Discord ping
          </span>
          <select
            value={ping}
            onChange={(e) => {
              disarm();
              setPing(e.target.value as AnnouncementPing);
            }}
            className="mt-2 h-11 w-full rounded-xl border border-line bg-wash px-3 text-[15px] text-ink focus:border-phosphor focus:outline-none focus:ring-1 focus:ring-phosphor"
          >
            <option value="none">No ping</option>
            <option value="here">@here — people online now</option>
            <option value="everyone">@everyone — notifies the server</option>
          </select>
        </label>
      )}

      {/* Sticky above the tab bar. The fields above run ~550px on a phone, and
          with the iOS keyboard up the visual viewport is ~380px tall — a button
          at the end of the document is off screen for the entire time you are
          writing. 3.75rem is the tab bar's real height (the same number
          components/app/frame.tsx reserves in <main>), plus half a rem of
          gutter so this reads as its own bar rather than a second row of the
          tab bar. The negative margins match AppBody's px-5 sm:px-6 so the
          fill reaches the column edges. */}
      <div className="sticky bottom-[calc(3.75rem+var(--safe-bottom)+0.5rem)] -mx-5 border-t border-line bg-paper/95 px-5 py-3 backdrop-blur sm:-mx-6 sm:px-6">
        {/* The failure rides in the bar with the button, not up in the flow
            where it used to sit. Once the send control became sticky, the
            error was the one piece of the exchange that wasn't: you tap Send
            from a bar pinned to the bottom, the action throws, and the only
            evidence is a red paragraph ~400px above the fold next to the
            fields. The button just goes back to saying "Send announcement",
            which is indistinguishable from a send that worked. */}
        {error && (
          <p
            role="alert"
            className="mb-2.5 rounded-lg border border-red-500/30 bg-red-500/10 px-3.5 py-2.5 text-[13px] leading-snug text-red-600 dark:text-red-300"
          >
            {error}
          </p>
        )}
        {sent ? (
          // The outcome replaces the BUTTON, not the form. Swapping the whole
          // form took ~500px out of a document that is still far taller than
          // the viewport (the nav list sits below), so the browser had no
          // reason to clamp the scroll and the sender stayed parked on
          // "Everything else" with the confirmation off screen above them.
          <div
            role="status"
            className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3"
          >
            <p className="text-[14px] font-medium text-emerald-700 dark:text-emerald-300">
              Sent to {sent.recipients}{" "}
              {sent.recipients === 1 ? "student" : "students"}.
            </p>
            <p className="mt-1 text-[12px] leading-snug text-ink-soft">
              {sent.discord
                ? "Posted to Discord too."
                : discord
                  ? "Discord post didn't go through — check the channel config."
                  : "In-app only."}
            </p>
            <button
              type="button"
              onClick={writeAnother}
              className="press mt-0.5 inline-flex min-h-11 items-center text-[13px] text-phosphor-ink underline"
            >
              Write another
            </button>
          </div>
        ) : confirming ? (
          // The confirm is a different target from the tap that armed it, and
          // the two are stacked rather than side by side: `audience` defaults
          // to "every enrolled student", ~200px at 14px, which leaves nothing
          // for Cancel at 320px. The consequence goes above both, so a thumb
          // travelling down the screen reads it before it lands on anything.
          <>
            <p className="mb-2.5 text-center text-[12px] leading-relaxed text-ink-soft">
              Sends to {audience}
              {email ? ", including email" : ""}
              {discord && ping !== "none" ? `, pinging @${ping}` : ""}.
            </p>
            <button
              type="button"
              onClick={send}
              disabled={!ready}
              className="press inline-flex h-11 w-full select-none items-center justify-center gap-2 rounded-md bg-phosphor text-[14px] font-semibold leading-none text-on-phosphor shadow-cta active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 disabled:active:scale-100"
            >
              <Send className="h-4 w-4" />
              Yes, send
            </button>
            <button
              type="button"
              onClick={disarm}
              className="press mt-2 inline-flex h-11 w-full select-none items-center justify-center rounded-md border border-line bg-wash text-[14px] font-medium text-ink-soft active:scale-[0.99]"
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={send}
            disabled={!ready || pending}
            aria-busy={pending}
            className="press inline-flex h-11 w-full select-none items-center justify-center gap-2 rounded-md bg-phosphor text-[14px] font-semibold leading-none text-on-phosphor shadow-cta active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 disabled:active:scale-100"
          >
            <Send className="h-4 w-4" />
            {pending ? "Sending…" : "Send announcement"}
          </button>
        )}
      </div>
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
