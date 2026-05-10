"use client";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Textarea, Label } from "@/components/ui/input";
import { saveSetting } from "./actions";

export function SettingsForm({ initial }: { initial: Record<string, any> }) {
  const knownKeys = ["contact_email", "applications_open", "active_cohort_name"];
  const [values, setValues] = useState<Record<string, string>>(
    Object.fromEntries(
      knownKeys.map((k) => [k, JSON.stringify(initial[k] ?? null, null, 2)]),
    ),
  );
  const [pending, start] = useTransition();
  const [savedKey, setSavedKey] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();

  function save(key: string) {
    setError(undefined);
    setSavedKey(undefined);
    start(async () => {
      try {
        await saveSetting(key, values[key]);
        setSavedKey(key);
      } catch (e: any) {
        setError(e.message);
      }
    });
  }

  return (
    <div className="space-y-6">
      {knownKeys.map((k) => (
        <div key={k}>
          <Label htmlFor={k}>{k}</Label>
          <Textarea
            id={k}
            rows={2}
            className="font-mono text-xs"
            value={values[k]}
            onChange={(e) => setValues({ ...values, [k]: e.target.value })}
          />
          <div className="mt-2 flex items-center gap-2">
            <Button size="sm" onClick={() => save(k)} disabled={pending}>
              {pending ? "Saving…" : "Save"}
            </Button>
            {savedKey === k && (
              <span className="text-xs text-emerald-300">Saved.</span>
            )}
          </div>
        </div>
      ))}
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}
