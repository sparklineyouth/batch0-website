"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Textarea, Label, FieldError } from "@/components/ui/input";
import { Toggle } from "@/components/ui/toggle";
import { submitCheckin } from "./actions";
import { getActionError } from "@/lib/action-error";

export function CheckinForm({
  initial,
}: {
  initial: {
    accomplished: string;
    next_up: string;
    blockers: string;
    is_milestone: boolean;
  };
}) {
  const router = useRouter();
  const [values, setValues] = useState(initial);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | undefined>();
  const [okMsg, setOkMsg] = useState<string | undefined>();

  function set<K extends keyof typeof initial>(k: K, v: (typeof initial)[K]) {
    setValues((p) => ({ ...p, [k]: v }));
  }

  function save() {
    setError(undefined);
    setOkMsg(undefined);
    start(async () => {
      try {
        await submitCheckin(values);
        setOkMsg(
          values.is_milestone
            ? "Check-in saved. Tagged as a milestone — we'll celebrate in #wins."
            : "Check-in saved. Your mentor will be notified.",
        );
        router.refresh();
      } catch (e: any) {
        setError(getActionError(e));
      }
    });
  }

  return (
    <div className="space-y-5">
      <Field
        label="What did you accomplish this week?"
        hint="The most important things you shipped, learned, or made progress on."
        value={values.accomplished}
        onChange={(v) => set("accomplished", v)}
        placeholder="Wrote my landing page, ran 3 user interviews, finished week-2 assignment."
      />
      <Field
        label="What's next?"
        hint="Top priorities for the coming week."
        value={values.next_up}
        onChange={(v) => set("next_up", v)}
        placeholder="Build MVP signup form, prep demo slides, schedule mentor call."
      />
      <Field
        label="Any blockers?"
        hint="Stuck on anything? Who can help?"
        value={values.blockers}
        onChange={(v) => set("blockers", v)}
        placeholder="Need a contact at a school for user interviews."
      />
      <Toggle
        label="Mark as a milestone 🎉"
        description="First paying customer, first hire, fundraise, demo shipped, etc. Tagged milestones get celebrated in the cohort's #wins channel."
        checked={values.is_milestone}
        onChange={(v) => set("is_milestone", v)}
      />
      {error && <FieldError>{error}</FieldError>}
      {okMsg && <p className="text-xs text-emerald-300">{okMsg}</p>}
      <div className="flex justify-end">
        <Button onClick={save} disabled={pending}>
          {pending ? "Saving…" : "Save this week's check-in"}
        </Button>
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  hint: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  return (
    <div>
      <Label>{label}</Label>
      <p className="mb-2 text-xs text-white/50">{hint}</p>
      <Textarea
        rows={4}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
      <div className="mt-1 text-right text-[10px] text-white/30">
        {value.length} / 4000
      </div>
    </div>
  );
}
