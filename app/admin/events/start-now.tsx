"use client";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Input, Label, Select, FieldError } from "@/components/ui/input";
import { getActionError } from "@/lib/action-error";
import { DEFAULT_LIVE_TITLE } from "@/lib/event-form";
import { startWebinarNow } from "./actions";
import type { CohortOption } from "./types";
import { Radio } from "lucide-react";

/** "Start a webinar now": one dialog with sensible defaults, then the room. */
export function StartNowButton({
  cohorts,
  defaultCohortId,
}: {
  cohorts: CohortOption[];
  defaultCohortId: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [who, setWho] = useState(defaultCohortId ? `cohort:${defaultCohortId}` : "public");
  const [notify, setNotify] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function go() {
    setError(null);
    start(async () => {
      try {
        // Redirects into the room on success.
        const r = await startWebinarNow({ title, who, notify: notify && who !== "staff" });
        if (r && !r.ok) setError(r.error);
      } catch (err) {
        setError(getActionError(err));
      }
    });
  }

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Radio className="h-4 w-4" /> Start a webinar now
      </Button>
      <ConfirmDialog
        open={open}
        title="Start a webinar now"
        confirmLabel={pending ? "Starting…" : "Go live"}
        pending={pending}
        onConfirm={go}
        onCancel={() => !pending && setOpen(false)}
        description={
          <div className="mt-2 space-y-3 text-left">
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
              <Select id="now-who" value={who} onChange={(e) => setWho(e.target.value)}>
                {cohorts.map((c) => (
                  <option key={c.id} value={`cohort:${c.id}`}>
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
            {error && <FieldError>{error}</FieldError>}
          </div>
        }
      />
    </>
  );
}
