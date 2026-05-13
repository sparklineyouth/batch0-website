"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/card";
import { Select, Textarea, FieldError } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { LocalTime } from "@/components/ui/local-time";
import { updateIntroStatus } from "./actions";

const STATUSES = [
  "requested",
  "intro_made",
  "meeting_held",
  "committed",
  "wired",
  "passed",
] as const;

const LABEL: Record<string, string> = {
  requested: "Requested",
  intro_made: "Intro made",
  meeting_held: "Meeting held",
  committed: "Committed",
  wired: "Wired",
  passed: "Passed",
};

export function IntroRow({ row }: { row: any }) {
  const router = useRouter();
  const [status, setStatus] = useState<string>(row.status);
  const [notes, setNotes] = useState<string>(row.admin_notes ?? "");
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | undefined>();
  const investor = Array.isArray(row.investor) ? row.investor[0] : row.investor;
  const team = Array.isArray(row.team) ? row.team[0] : row.team;

  function save() {
    setErr(undefined);
    start(async () => {
      try {
        const result = await updateIntroStatus({
          introId: row.id,
          status: status as any,
          adminNotes: notes,
        });
        if (!result.ok) {
          setErr(result.error);
          return;
        }
        router.refresh();
      } catch (e: any) {
        setErr(e?.message || "Couldn't update intro. Try again.");
      }
    });
  }

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-base font-semibold">
            {investor?.full_name ?? investor?.email}{" "}
            <span className="text-white/40">→</span> {team?.name}
          </h3>
          <p className="text-xs text-white/40">
            Requested <LocalTime value={row.created_at} />
          </p>
          {row.message && (
            <p className="mt-3 whitespace-pre-wrap rounded-lg border border-white/10 bg-zinc-950/40 p-3 text-sm text-white/80">
              {row.message}
            </p>
          )}
        </div>
        <div className="flex flex-col gap-2">
          <Select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="min-w-[10rem]"
          >
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {LABEL[s]}
              </option>
            ))}
          </Select>
        </div>
      </div>
      <div className="mt-3">
        <Textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Internal notes…"
          rows={2}
          maxLength={2000}
        />
      </div>
      <div className="mt-3 flex items-center justify-between">
        <FieldError>{err}</FieldError>
        <Button size="sm" onClick={save} disabled={pending}>
          {pending ? "Saving…" : "Save"}
        </Button>
      </div>
    </Card>
  );
}
