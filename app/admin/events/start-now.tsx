"use client";
import { useState, useTransition } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Input, Label, Select, FieldError } from "@/components/ui/input";
import { getActionError } from "@/lib/action-error";
import { cohortWho, DEFAULT_LIVE_TITLE } from "@/lib/event-form";
import { joinNames } from "@/lib/live";
import { startWebinarNow } from "./actions";
import type { CohortOption } from "./types";
import { Radio } from "lucide-react";

/** A hosted webinar under "Live now", as the dialog shows it. */
export type LiveWebinar = {
  id: string;
  title: string;
  /** The Who select's value for its audience. */
  who: string;
  /** Hosts on air right now. */
  hosting: string[];
};

/**
 * "Start a webinar now": one dialog with sensible defaults, then the room.
 * When a webinar is already live, the dialog leads with Join; starting a
 * second one for the same people takes a deliberate "Start another".
 */
export function StartNowButton({
  cohorts,
  defaultCohortId,
  live,
}: {
  cohorts: CohortOption[];
  defaultCohortId: string | null;
  live: LiveWebinar[];
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [who, setWho] = useState(defaultCohortId ? cohortWho(defaultCohortId) : "public");
  const [notify, setNotify] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // One the server found live for the same people after this page loaded.
  const [serverDup, setServerDup] = useState<{ id: string; title: string } | null>(null);
  const [pending, start] = useTransition();

  const duplicate = serverDup ?? live.find((w) => w.who === who) ?? null;

  function go() {
    setError(null);
    start(async () => {
      try {
        // Redirects into the room on success.
        const r = await startWebinarNow({
          title,
          who,
          notify: notify && who !== "staff",
          again: !!duplicate,
        });
        if (!r) return;
        if (!r.ok) setError(r.error);
        else if (r.data) setServerDup({ id: r.data.liveId, title: r.data.liveTitle });
      } catch (err) {
        setError(getActionError(err));
      }
    });
  }

  const shown: { id: string; label: string }[] = live.map((w) => ({
    id: w.id,
    label: `${w.hosting.length ? `${joinNames(w.hosting)} is live` : "Live"}: ${w.title}`,
  }));
  if (serverDup && !live.some((w) => w.id === serverDup.id)) {
    shown.push({ id: serverDup.id, label: `Live: ${serverDup.title}` });
  }

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Radio className="h-4 w-4" /> Start a webinar now
      </Button>
      <ConfirmDialog
        open={open}
        title="Start a webinar now"
        confirmLabel={pending ? "Starting…" : duplicate ? "Start another" : "Go live"}
        pending={pending}
        onConfirm={go}
        onCancel={() => !pending && setOpen(false)}
        description={
          <div className="mt-2 space-y-3 text-left">
            {shown.length > 0 && (
              <ul className="space-y-2">
                {shown.map((w) => (
                  <li
                    key={w.id}
                    className="flex items-center justify-between gap-3 rounded-md border border-line px-3 py-2 text-sm"
                  >
                    <span className="min-w-0 truncate text-ink-soft">{w.label}</span>
                    <Link
                      href={`/dashboard/events/${w.id}/live`}
                      className="shrink-0 font-semibold text-phosphor-ink hover:underline"
                    >
                      Join
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            <div>
              <Label htmlFor="now-title">Title</Label>
              <Input
                id="now-title"
                value={title}
                maxLength={200}
                placeholder={DEFAULT_LIVE_TITLE}
                onChange={(e) => setTitle(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="now-who">Who</Label>
              <Select
                id="now-who"
                value={who}
                onChange={(e) => {
                  setWho(e.target.value);
                  setServerDup(null);
                }}
              >
                {cohorts.map((c) => (
                  <option key={c.id} value={cohortWho(c.id)}>
                    {c.name}
                  </option>
                ))}
                <option value="public">Everyone signed in</option>
                <option value="staff">Staff only (rehearsal)</option>
              </Select>
            </div>
            {who !== "staff" && (
              <label className="flex items-center gap-2 text-sm text-ink">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-[#ffbb00]"
                  checked={notify}
                  onChange={(e) => setNotify(e.target.checked)}
                />
                Tell them it&apos;s live
              </label>
            )}
            {duplicate && (
              <p className="text-xs text-amber-700 dark:text-amber-400">
                One is already live for them. Join it, or start another.
              </p>
            )}
            {error && <FieldError>{error}</FieldError>}
          </div>
        }
      />
    </>
  );
}
