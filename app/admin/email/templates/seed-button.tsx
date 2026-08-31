"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { PackagePlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getActionError } from "@/lib/action-error";
import { restoreBuiltInTemplates } from "./actions";

/**
 * Creates database rows for the built-in templates that don't have one yet.
 *
 * Insert-only, never an overwrite — the whole point is that an admin's edits
 * survive. Safe to press repeatedly; on a second press it reports that
 * everything is already there.
 */
export function SeedButton() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<string>();
  const [failed, setFailed] = useState(false);

  return (
    <div className="relative">
      <Button
        variant="secondary"
        onClick={() =>
          start(async () => {
            setMessage(undefined);
            try {
              const res = await restoreBuiltInTemplates();
              setFailed(!res.ok);
              setMessage(res.message);
              if (res.ok) router.refresh();
            } catch (err) {
              setFailed(true);
              setMessage(getActionError(err));
            }
          })
        }
        disabled={pending}
      >
        <PackagePlus className="h-4 w-4" />
        {pending ? "Adding…" : "Add built-in templates"}
      </Button>
      {message && (
        <p
          role="status"
          className={`absolute right-0 top-11 whitespace-nowrap text-xs ${
            failed ? "text-red-500" : "text-emerald-600 dark:text-emerald-400"
          }`}
        >
          {message}
        </p>
      )}
    </div>
  );
}
