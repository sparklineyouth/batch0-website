"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input, FieldError } from "@/components/ui/input";
import { createTeam } from "./actions";

export function CreateTeamForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [err, setErr] = useState<string | undefined>();
  const [pending, start] = useTransition();

  function submit() {
    setErr(undefined);
    start(async () => {
      try {
        await createTeam({ name });
        router.refresh();
      } catch (e: any) {
        setErr(e.message);
      }
    });
  }

  return (
    <div className="flex flex-wrap gap-2">
      <Input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Team name"
        maxLength={60}
        className="max-w-sm"
        onKeyDown={(e) => {
          if (e.key === "Enter" && name.trim()) submit();
        }}
      />
      <Button onClick={submit} disabled={pending || !name.trim()}>
        {pending ? "Creating…" : "Create team"}
      </Button>
      <div className="basis-full">
        <FieldError>{err}</FieldError>
      </div>
    </div>
  );
}
