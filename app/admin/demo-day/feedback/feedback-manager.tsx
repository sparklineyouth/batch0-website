"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ChevronDown, ChevronUp } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea, Label, FieldError } from "@/components/ui/input";
import { LocalTime } from "@/components/ui/local-time";
import { RubricScorecard } from "@/components/demo-day/scorecard";
import { getActionError } from "@/lib/action-error";
import type { Scorecard } from "@/lib/demo-day-rubric";
import { releaseFeedback, unreleaseFeedback } from "./actions";

export type TeamFeedback = {
  teamId: string;
  teamName: string;
  cohortName?: string | null;
  card: Scorecard;
  release: {
    releasedAt: string | null;
    showOnDashboard: boolean;
    includeComments: boolean;
    note: string | null;
    emailedAt: string | null;
    emailCount: number;
  } | null;
};

export function FeedbackManager({ team }: { team: TeamFeedback }) {
  const router = useRouter();
  const released = !!team.release?.releasedAt;
  const scored = team.card.scoredCount > 0;

  const [open, setOpen] = useState(false);
  const [showOnDashboard, setShowOnDashboard] = useState(
    team.release?.showOnDashboard ?? true,
  );
  // Email is opt-in on every release, including a re-release. A sent email
  // can't be recalled, so it should never be the box someone forgets is
  // already ticked.
  const [sendEmailToo, setSendEmailToo] = useState(false);
  const [includeComments, setIncludeComments] = useState(
    team.release?.includeComments ?? true,
  );
  const [note, setNote] = useState(team.release?.note ?? "");
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | undefined>();
  const [okMsg, setOkMsg] = useState<string | undefined>();

  function release() {
    setErr(undefined);
    setOkMsg(undefined);
    if (sendEmailToo) {
      const already = (team.release?.emailCount ?? 0) > 0;
      if (
        !confirm(
          already
            ? `This team has already been emailed their scorecard ${team.release!.emailCount} time(s). Send it again?`
            : `Email every member of ${team.teamName} their scorecard now?`,
        )
      )
        return;
    }
    start(async () => {
      try {
        const res = await releaseFeedback({
          teamId: team.teamId,
          showOnDashboard,
          sendEmail: sendEmailToo,
          includeComments,
          note,
        });
        setOkMsg(
          [
            showOnDashboard ? "On their dashboard" : "Dashboard copy hidden",
            sendEmailToo
              ? `emailed ${res.emailed} member${res.emailed === 1 ? "" : "s"}${
                  res.skipped > 0 ? ` (${res.skipped} skipped)` : ""
                }`
              : null,
          ]
            .filter(Boolean)
            .join(" · ") + ".",
        );
        setSendEmailToo(false);
        router.refresh();
      } catch (e) {
        setErr(getActionError(e));
      }
    });
  }

  function hide() {
    if (
      !confirm(
        `Take ${team.teamName}'s scorecard off their dashboard? Any email already sent stays sent.`,
      )
    )
      return;
    setErr(undefined);
    setOkMsg(undefined);
    start(async () => {
      try {
        await unreleaseFeedback(team.teamId);
        setOkMsg("Hidden from their dashboard.");
        router.refresh();
      } catch (e) {
        setErr(getActionError(e));
      }
    });
  }

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Link
            href={`/admin/teams/${team.teamId}`}
            className="font-display text-base font-semibold tracking-[-0.02em] text-ink hover:underline"
          >
            {team.teamName}
          </Link>
          <p className="mt-0.5 text-xs text-ink-faint">
            {team.cohortName ? `${team.cohortName} · ` : ""}
            {scored
              ? `${team.card.judgeCount} judge${team.card.judgeCount === 1 ? "" : "s"} · ${
                  team.card.weightedPct != null
                    ? `${team.card.weightedPct.toFixed(1)}% weighted`
                    : "unweighted"
                }`
              : "Not scored yet"}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <StatusPill released={released} scored={scored} />
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
          >
            {open ? (
              <>
                Hide <ChevronUp className="ml-1 h-3.5 w-3.5" />
              </>
            ) : (
              <>
                {scored ? "Review & release" : "View"}{" "}
                <ChevronDown className="ml-1 h-3.5 w-3.5" />
              </>
            )}
          </Button>
        </div>
      </div>

      {released && (
        <p className="mt-2 text-xs text-ink-faint">
          Released <LocalTime value={team.release!.releasedAt!} />
          {team.release!.showOnDashboard
            ? " · visible on their dashboard"
            : " · hidden from their dashboard"}
          {team.release!.emailedAt ? (
            <>
              {" "}
              · emailed <LocalTime value={team.release!.emailedAt} /> (
              {team.release!.emailCount} message
              {team.release!.emailCount === 1 ? "" : "s"})
            </>
          ) : (
            " · never emailed"
          )}
        </p>
      )}

      {open && (
        <div className="mt-5 border-t border-line pt-5">
          {/* Exactly what the founders get, including whether notes are in
              it — the preview follows the checkbox, so a decision about the
              notes is made by looking at them. */}
          <RubricScorecard card={team.card} showComments={includeComments} />

          {scored && (
            <div className="mt-6 space-y-3 border-t border-line pt-5">
              <ChannelCheckbox
                label="Show on their dashboard"
                description="The card appears on the team's Demo Day tab, and every member gets a notification."
                checked={showOnDashboard}
                onChange={setShowOnDashboard}
                disabled={pending}
              />
              <ChannelCheckbox
                label="Email it to every member"
                description="A complete copy of the card, not a link. Can't be unsent."
                checked={sendEmailToo}
                onChange={setSendEmailToo}
                disabled={pending}
              />
              <ChannelCheckbox
                label="Include the judges' written notes"
                description="Shared as written, never with a judge's name. Untick to send numbers and bands only."
                checked={includeComments}
                onChange={setIncludeComments}
                disabled={pending}
              />

              <div className="pt-1">
                <Label htmlFor={`note-${team.teamId}`}>
                  Note to the team (optional)
                </Label>
                <Textarea
                  id={`note-${team.teamId}`}
                  rows={3}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  maxLength={1500}
                  placeholder="Shown above the scores, on the dashboard and in the email."
                />
              </div>

              <FieldError>{err}</FieldError>
              {okMsg && (
                <p className="text-xs text-emerald-700 dark:text-emerald-300">
                  {okMsg}
                </p>
              )}

              <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                {released ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={hide}
                    disabled={pending}
                  >
                    Take it down
                  </Button>
                ) : (
                  <span />
                )}
                <Button onClick={release} disabled={pending}>
                  {pending
                    ? "Releasing…"
                    : released
                      ? "Update release"
                      : "Release feedback"}
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

function StatusPill({
  released,
  scored,
}: {
  released: boolean;
  scored: boolean;
}) {
  const cls = released
    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
    : scored
      ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-200"
      : "border-line bg-wash text-ink-faint";
  return (
    <span
      className={`rounded-full border px-2.5 py-1 text-[11px] font-medium ${cls}`}
    >
      {released ? "Released" : scored ? "Ready" : "Unscored"}
    </span>
  );
}

function ChannelCheckbox({
  label,
  description,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-line bg-wash px-3.5 py-3">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-4 w-4 shrink-0 accent-phosphor"
      />
      <span className="min-w-0">
        <span className="block text-sm font-medium text-ink">{label}</span>
        <span className="mt-0.5 block text-xs text-ink-soft">
          {description}
        </span>
      </span>
    </label>
  );
}
