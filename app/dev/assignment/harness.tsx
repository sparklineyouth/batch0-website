"use client";
import { useState } from "react";
import { SubmitForm } from "@/components/assignments/submit-form";
import { startingWork, type DraftRow, type DraftSaveResult } from "@/lib/assignment-drafts";
import type { ActionResult } from "@/lib/action-result";

export type Scenario = "tabs" | "fresh" | "flaky" | "revoked" | "off";

const SUBMITTED_AT = "2026-10-16T21:00:00.000Z";
const SUBMISSION = { body: "Shipped the landing page; 3 interviews booked.", link_url: null, submitted_at: SUBMITTED_AT };

/**
 * A pretend server for the preview, shared by every form on the page so two
 * "tabs" really do race: the same compare-and-set rule as
 * save_course_assignment_draft() (0105), in memory.
 */
function makeServer(scenario: Scenario) {
  const draft: DraftRow | null =
    scenario === "tabs"
      ? {
          body: "Shipped the landing page; 3 interviews booked.\n\nNext: a pricing test with the waitlist.",
          link_url: null,
          version: 1,
          updated_at: "2026-10-17T13:42:00.000Z",
        }
      : null;
  let row = draft ? { ...draft } : null;
  let failuresLeft = scenario === "flaky" ? 2 : 0;
  const wait = () => new Promise((r) => setTimeout(r, 450));

  async function saveDraft(input: {
    assignmentId: string;
    body?: string | null;
    linkUrl?: string | null;
    baseVersion?: number | null;
  }): Promise<DraftSaveResult> {
    await wait();
    if (scenario === "revoked") return { ok: false, reason: "forbidden" };
    if (failuresLeft > 0) {
      failuresLeft--;
      return { ok: false, reason: "error" };
    }
    const base = input.baseVersion ?? 0;
    if ((row?.version ?? 0) !== base) return { ok: false, reason: "stale", version: row?.version ?? null };
    row = {
      body: input.body || null,
      link_url: input.linkUrl || null,
      version: base + 1,
      updated_at: new Date().toISOString(),
    };
    return { ok: true, version: row.version, savedAt: row.updated_at };
  }

  async function submit(input: {
    assignmentId: string;
    body?: string | null;
    linkUrl?: string | null;
    draftVersion?: number | null;
  }): Promise<ActionResult<{ draftVersion: number }>> {
    await wait();
    if (!(input.body ?? "").trim() && !(input.linkUrl ?? "").trim()) {
      return { ok: false, error: "Add a link or some text." };
    }
    const known = input.draftVersion ?? 0;
    if (row && known > 0 && row.version <= known) {
      row = null;
      return { ok: true, data: { draftVersion: 0 } };
    }
    return { ok: true, data: { draftVersion: known } };
  }

  return { draft, saveDraft, submit };
}

export function AssignmentDraftHarness({ scenario }: { scenario: Scenario }) {
  // Kept across re-renders (Submit refreshes the page), like a real server.
  const [server] = useState(() => makeServer(scenario));
  const submission = scenario === "tabs" ? SUBMISSION : null;
  const start = startingWork({ submission, draft: server.draft });
  const initial = submission ? { body: submission.body, link: "" } : null;
  const tabs = scenario === "tabs" ? ["Tab A", "Tab B"] : ["The form"];
  return (
    <div className="space-y-10">
      {tabs.map((label) => (
        <section key={label} className="rounded-xl border border-line p-5">
          <h2 className="mb-4 font-mono text-xs uppercase tracking-wider text-ink-faint">{label}</h2>
          <SubmitForm
            assignmentId="00000000-0000-4000-8000-000000000000"
            type="text_or_link"
            initial={initial}
            start={start}
            autosave={scenario === "off" ? "off" : "on"}
            pastDue={false}
            actions={{ saveDraft: server.saveDraft, submit: server.submit }}
          />
        </section>
      ))}
    </div>
  );
}
