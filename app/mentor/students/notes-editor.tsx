"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { saveMentorNote } from "../actions";

export function NotesEditor({
  assignmentId,
  initialNotes,
}: {
  assignmentId: string;
  initialNotes: string;
}) {
  const router = useRouter();
  const [notes, setNotes] = useState(initialNotes);
  const [pending, start] = useTransition();
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [error, setError] = useState<string | undefined>();

  function save() {
    setError(undefined);
    start(async () => {
      try {
        await saveMentorNote(assignmentId, notes);
        setSavedAt(new Date());
        router.refresh();
      } catch (e: any) {
        setError(e.message);
      }
    });
  }

  return (
    <div>
      <Textarea
        rows={4}
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder="Notes from your sessions, things to follow up, what they're working on…"
      />
      <div className="mt-3 flex items-center justify-between text-xs">
        {error ? (
          <span className="text-red-400">{error}</span>
        ) : savedAt ? (
          <span className="text-emerald-300/80">
            Saved at {savedAt.toLocaleTimeString()}
          </span>
        ) : (
          <span />
        )}
        <Button size="sm" variant="secondary" onClick={save} disabled={pending}>
          {pending ? "Saving…" : "Save notes"}
        </Button>
      </div>
    </div>
  );
}
