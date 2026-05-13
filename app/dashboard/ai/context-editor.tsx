"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input, Textarea, Label } from "@/components/ui/input";
import { saveAiContext } from "./actions";
import { getActionError } from "@/lib/action-error";

const FIELDS: { key: string; label: string; multiline?: boolean }[] = [
  { key: "startup_name", label: "Startup name" },
  { key: "one_liner", label: "One-line pitch" },
  { key: "problem", label: "Problem you're solving", multiline: true },
  { key: "customer", label: "Target customer" },
  { key: "solution", label: "Solution / how it works", multiline: true },
  { key: "stage", label: "Current stage (idea / validating / building / launched)" },
];

export function ContextEditor({
  initial,
}: {
  initial: Record<string, string>;
}) {
  const router = useRouter();
  const [values, setValues] = useState<Record<string, string>>(() => {
    const out: Record<string, string> = {};
    for (const f of FIELDS) out[f.key] = initial[f.key] ?? "";
    return out;
  });
  const [pending, start] = useTransition();
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | undefined>();

  function save() {
    setError(undefined);
    setSaved(false);
    start(async () => {
      try {
        await saveAiContext(values);
        setSaved(true);
        router.refresh();
      } catch (e: any) {
        setError(getActionError(e));
      }
    });
  }

  return (
    <div className="space-y-3">
      {FIELDS.map((f) => (
        <div key={f.key}>
          <Label>{f.label}</Label>
          {f.multiline ? (
            <Textarea
              rows={3}
              value={values[f.key]}
              onChange={(e) =>
                setValues((v) => ({ ...v, [f.key]: e.target.value }))
              }
            />
          ) : (
            <Input
              value={values[f.key]}
              onChange={(e) =>
                setValues((v) => ({ ...v, [f.key]: e.target.value }))
              }
            />
          )}
        </div>
      ))}
      <div className="flex items-center gap-2 pt-1">
        <Button size="sm" onClick={save} disabled={pending}>
          {pending ? "Saving…" : "Save context"}
        </Button>
        {saved && <span className="text-xs text-emerald-300">Saved.</span>}
        {error && <span className="text-xs text-red-400">{error}</span>}
      </div>
    </div>
  );
}
