"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { FieldError } from "@/components/ui/input";
import { Sparkles } from "lucide-react";
import { aiScreenApplication } from "./screen-actions";

export function AiScreenButton({
  applicationId,
  alreadyScored,
}: {
  applicationId: string;
  alreadyScored: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | undefined>();

  function run() {
    setErr(undefined);
    start(async () => {
      try {
        await aiScreenApplication({ applicationId });
        router.refresh();
      } catch (e: any) {
        setErr(e.message);
      }
    });
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        size="sm"
        variant={alreadyScored ? "secondary" : "primary"}
        onClick={run}
        disabled={pending}
      >
        <Sparkles className="h-3.5 w-3.5" />
        {pending ? "Scoring…" : alreadyScored ? "Re-score" : "AI screen"}
      </Button>
      <FieldError>{err}</FieldError>
    </div>
  );
}
