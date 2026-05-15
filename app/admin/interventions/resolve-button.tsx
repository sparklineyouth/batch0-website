"use client";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { resolveIntervention } from "./actions";
import { getActionError } from "@/lib/action-error";

export function ResolveButton({ id }: { id: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button
      size="sm"
      variant="ghost"
      disabled={pending}
      onClick={() =>
        start(async () => {
          try {
            await resolveIntervention(id);
            router.refresh();
          } catch (e) {
            alert(getActionError(e));
          }
        })
      }
    >
      {pending ? "…" : "Resolve"}
    </Button>
  );
}
