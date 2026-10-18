import { notFound } from "next/navigation";
import { AssignmentDraftHarness, type Scenario } from "./harness";

/**
 * Interface preview for assignment drafts (migration 0105): the real
 * SubmitForm, against an in-memory stand-in for the server, so autosave's
 * states can be walked without a student account or a database.
 *
 * Gated on VERCEL_ENV: renders on localhost and branch previews, 404s on
 * production. Not NODE_ENV, which Vercel sets to "production" for every
 * deployment, previews included.
 *
 *   (default)          two "tabs" opened on the same restored draft: type in
 *                      A, then in B — B is refused as stale and says so
 *   ?scenario=fresh    nothing handed in, no draft
 *   ?scenario=flaky    the first two saves fail, then it recovers
 *   ?scenario=lost     the first save lands but its answer is lost; the
 *                      retry is recognised as that same save, not "stale"
 *   ?scenario=revoked  the student lost access: saving stops at once
 *   ?scenario=off      before 0105 runs: no autosave, as before drafts
 */
export const metadata = {
  title: "Assignment draft preview · batch0",
  robots: { index: false, follow: false },
};

const SCENARIOS: readonly Scenario[] = ["tabs", "fresh", "flaky", "lost", "revoked", "off"];

export default async function AssignmentDraftPreviewPage(props: {
  searchParams: Promise<{ scenario?: string }>;
}) {
  if (process.env.VERCEL_ENV === "production") notFound();
  const q = await props.searchParams;
  const scenario = SCENARIOS.find((s) => s === q.scenario) ?? "tabs";
  return (
    <main className="mx-auto max-w-2xl px-5 py-10">
      <p className="mb-6 rounded-lg border border-amber-400/40 bg-amber-400/[0.06] px-3 py-2 text-xs text-amber-700 dark:text-amber-200">
        Preview ({scenario}). Nothing here is saved anywhere — the server is
        pretend, and resets on reload.
      </p>
      <AssignmentDraftHarness key={scenario} scenario={scenario} />
    </main>
  );
}
