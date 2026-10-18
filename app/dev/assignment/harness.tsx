"use client";
import { useState } from "react";
import { SubmitForm, type DraftTransport } from "@/components/assignments/submit-form";
import {
  startingWork,
  submitConflict,
  type DraftRow,
  type DraftSaveResult,
  type DraftState,
  type SubmissionSnapshot,
  type SubmitOutcome,
} from "@/lib/assignment-drafts";
import type { DraftSaveInput } from "@/lib/assignment-drafts-client";
import type { ActionResult } from "@/lib/action-result";

export type Scenario = "tabs" | "fresh" | "flaky" | "lost" | "revoked" | "off";

const SUBMITTED_AT = "2026-10-16T21:00:00.000Z";
const SUBMISSION: SubmissionSnapshot = {
  body: "Shipped the landing page; 3 interviews booked.",
  link_url: null,
  submitted_at: SUBMITTED_AT,
};

/**
 * A pretend server for the preview, shared by every form on the page so two
 * "tabs" really do race: the same compare-and-set, idempotent-retry and
 * clear-on-submit rules as save_ / clear_course_assignment_draft() (0105) and
 * submitAssignment, in memory.
 */
function makeServer(scenario: Scenario) {
  const draft: DraftRow | null =
    scenario === "tabs"
      ? {
          body: "Shipped the landing page; 3 interviews booked.\n\nNext: a pricing test with the waitlist.",
          link_url: null,
          version: 1,
          updated_at: "2026-10-17T13:42:00.000Z",
          cleared_at: null,
        }
      : null;
  let row: DraftRow | null = draft ? { ...draft } : null;
  let submission: SubmissionSnapshot | null = scenario === "tabs" ? { ...SUBMISSION } : null;
  let failuresLeft = scenario === "flaky" ? 2 : 0;
  // "lost": the first save is written, but its answer never arrives.
  let loseNextAnswer = scenario === "lost";
  const wait = () => new Promise((r) => setTimeout(r, 450));

  async function saveDraft(input: DraftSaveInput): Promise<DraftSaveResult> {
    await wait();
    if (scenario === "revoked") return { ok: false, reason: "forbidden" };
    if (failuresLeft > 0) {
      failuresLeft--;
      return { ok: false, reason: "error" };
    }
    const body = input.body || null;
    const link = input.linkUrl || null;
    if ((row?.version ?? 0) !== input.baseVersion) {
      // The same text arriving twice is the save that already happened.
      if (row && !row.cleared_at && row.body === body && row.link_url === link) {
        return { ok: true, version: row.version, savedAt: row.updated_at };
      }
      return { ok: false, reason: "stale", version: row?.version ?? null };
    }
    row = {
      body,
      link_url: link,
      version: input.baseVersion + 1,
      updated_at: new Date().toISOString(),
      cleared_at: null,
    };
    if (loseNextAnswer) {
      loseNextAnswer = false;
      throw new TypeError("Failed to fetch");
    }
    return { ok: true, version: row.version, savedAt: row.updated_at };
  }

  async function loadDraft(): Promise<DraftState | null> {
    await wait();
    return { state: "ready", draft: row ? { ...row } : null, submission: submission ? { ...submission } : null };
  }

  async function submit(input: {
    assignmentId: string;
    body?: string | null;
    linkUrl?: string | null;
    draftVersion?: number | null;
    force?: boolean;
  }): Promise<ActionResult<SubmitOutcome>> {
    await wait();
    const body = (input.body ?? "").trim();
    const link = (input.linkUrl ?? "").trim();
    if (!body && !link) return { ok: false, error: "Add a link or some text." };
    const known = typeof input.draftVersion === "number" ? input.draftVersion : null;
    const conflict = submitConflict({ known, draft: row, submission, input: { body, link }, force: input.force });
    if (conflict.stale) return { ok: true, data: { outcome: "stale" } };
    submission = { body: body || null, link_url: link || null, submitted_at: new Date().toISOString() };
    let draftVersion = known ?? 0;
    if (row && known !== null && row.version <= conflict.upTo) {
      if (!row.cleared_at) {
        const now = new Date().toISOString();
        row = { body: null, link_url: null, version: row.version + 1, updated_at: now, cleared_at: now };
      }
      draftVersion = row.version;
    }
    return { ok: true, data: { outcome: "submitted", draftVersion } };
  }

  return { draft, saveDraft, loadDraft, submit };
}

export function AssignmentDraftHarness({ scenario }: { scenario: Scenario }) {
  // Kept across re-renders (Submit refreshes the page), like a real server.
  const [server] = useState(() => makeServer(scenario));
  const submission = scenario === "tabs" ? SUBMISSION : null;
  const start = startingWork({ submission, draft: server.draft });
  const initial = submission ? { body: submission.body ?? "", link: "" } : null;
  const tabs = scenario === "tabs" ? ["Tab A", "Tab B"] : ["The form"];
  const transport: DraftTransport = {
    saveDraft: server.saveDraft,
    loadDraft: server.loadDraft,
    submit: server.submit as DraftTransport["submit"],
  };
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
            actions={transport}
          />
        </section>
      ))}
    </div>
  );
}
