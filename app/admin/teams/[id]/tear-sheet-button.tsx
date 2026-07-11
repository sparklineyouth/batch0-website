"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { LocalTime } from "@/components/ui/local-time";
import { Sparkles } from "lucide-react";
import { generateTearSheet } from "./tear-sheet-actions";
import { getActionError } from "@/lib/action-error";

export function TearSheetCard({
  teamId,
  existing,
  generatedAt,
}: {
  teamId: string;
  existing: string | null;
  generatedAt: string | null;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | undefined>();

  function run() {
    setErr(undefined);
    start(async () => {
      try {
        await generateTearSheet({ teamId });
        router.refresh();
      } catch (e: any) {
        setErr(getActionError(e));
      }
    });
  }

  return (
    <div>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-ink">Investor tear sheet</h2>
          <p className="mt-1 text-xs text-ink-faint">
            AI summary shown on the investor team page. Regenerate after
            material team changes.
          </p>
        </div>
        <Button
          size="sm"
          variant={existing ? "secondary" : "primary"}
          onClick={run}
          disabled={pending}
        >
          <Sparkles className="h-3.5 w-3.5" />
          {pending ? "Generating…" : existing ? "Regenerate" : "Generate"}
        </Button>
      </div>
      {err && <p className="mt-2 text-xs text-red-700 dark:text-red-300">{err}</p>}
      {existing ? (
        <>
          <p className="mt-4 whitespace-pre-wrap text-sm text-ink-soft">
            {existing}
          </p>
          {generatedAt && (
            <p className="mt-3 text-[11px] text-ink-faint">
              Last generated <LocalTime value={generatedAt} />
            </p>
          )}
        </>
      ) : (
        <p className="mt-4 rounded-lg border border-line bg-wash px-4 py-3 text-sm text-ink-soft">
          No tear sheet yet. Click Generate to draft one from this team's
          description, members, and pitch submission.
        </p>
      )}
    </div>
  );
}
