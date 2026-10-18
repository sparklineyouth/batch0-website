"use client";
import { useState } from "react";
import { FollowUpDetails } from "@/app/admin/progress/follow-up-drawer";
import type { FollowUpDrawerData } from "@/app/admin/progress/actions";

const ME = "00000000-0000-4000-8000-000000000001";
const PRIYA = "00000000-0000-4000-8000-000000000002";

/**
 * The drawer's states side by side: an open follow-up, none yet with history,
 * read-only, and one whose owner's role no longer lets them own it.
 */
export function FollowUpPreview() {
  const base: FollowUpDrawerData = {
    ready: true,
    student: { id: "00000000-0000-4000-8000-0000000000aa", name: "Ada Lovelace" },
    active: null,
    history: [],
    owners: [
      { id: ME, name: "Sam Okafor" },
      { id: PRIYA, name: "Priya Raman" },
    ],
    canEdit: true,
    viewerId: ME,
    today: "2026-10-17",
  };
  const closed = {
    id: "f0",
    studentId: base.student.id,
    studentName: "Ada Lovelace",
    ownerId: PRIYA,
    ownerName: "Priya Raman",
    nextCheckOn: "2026-09-30",
    note: "No weekly update for week 1. Emailed to check the dashboard link works.",
    status: "closed" as const,
    closingNote: "Link was fine; week 1 update handed in Oct 1.",
    createdByName: "Priya Raman",
    createdAt: "2026-09-26T15:00:00.000Z",
    closedByName: "Priya Raman",
    closedAt: "2026-10-01T15:00:00.000Z",
    updatedAt: "2026-10-01T15:00:00.000Z",
  };
  const open: FollowUpDrawerData = {
    ...base,
    active: {
      ...closed,
      id: "f1",
      ownerId: PRIYA,
      nextCheckOn: "2026-10-17",
      note: "No weekly update for weeks 3 and 4. Emailed Tuesday; will check the week 5 update.",
      status: "open",
      closingNote: null,
      createdAt: "2026-10-12T15:00:00.000Z",
      closedByName: null,
      closedAt: null,
      updatedAt: "2026-10-12T15:00:00.000Z",
    },
    history: [closed],
  };
  const [n, setN] = useState(0);
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      {[
        open,
        { ...base, history: [closed] },
        { ...open, canEdit: false, owners: [] },
        // Priya's role changed: she still owns it, but isn't offered as owner.
        { ...open, owners: base.owners.filter((o) => o.id !== PRIYA) },
      ].map((d, i) => (
        <div key={`${i}:${n}`} className="max-w-xl rounded-lg border border-line px-5 py-5">
          <FollowUpDetails data={d} onChanged={() => setN((x) => x + 1)} />
        </div>
      ))}
    </div>
  );
}
