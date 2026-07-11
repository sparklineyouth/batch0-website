"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  Input,
  Textarea,
  Label,
  Select,
  FieldError,
} from "@/components/ui/input";
import { getActionError } from "@/lib/action-error";
import { issueCharge } from "./actions";

type Profile = { id: string; email: string; full_name: string | null };

export function ChargeManager({ profiles }: { profiles: Profile[] }) {
  const router = useRouter();
  const [userId, setUserId] = useState("");
  const [kind, setKind] = useState<"fee" | "fine">("fee");
  const [amount, setAmount] = useState("25.00");
  const [description, setDescription] = useState("");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | undefined>();
  const [okMsg, setOkMsg] = useState<string | undefined>();

  function submit() {
    setError(undefined);
    setOkMsg(undefined);
    const cents = Math.round(parseFloat(amount) * 100);
    if (!userId) return setError("Pick a student.");
    if (!description.trim()) return setError("Description is required.");
    if (!Number.isFinite(cents) || cents < 50) {
      return setError("Amount must be at least $0.50.");
    }
    start(async () => {
      try {
        await issueCharge({
          userId,
          kind,
          amountCents: cents,
          description,
        });
        setOkMsg(`${kind === "fine" ? "Fine" : "Fee"} issued.`);
        setDescription("");
        router.refresh();
      } catch (e: any) {
        setError(getActionError(e));
      }
    });
  }

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <div>
        <Label>User</Label>
        <Select value={userId} onChange={(e) => setUserId(e.target.value)}>
          <option value="">— Pick a user —</option>
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.full_name || p.email}
            </option>
          ))}
        </Select>
      </div>
      <div>
        <Label>Type</Label>
        <Select
          value={kind}
          onChange={(e) => setKind(e.target.value as "fee" | "fine")}
        >
          <option value="fee">Fee — soft prompt, user keeps access</option>
          <option value="fine">Fine — hard block until paid or waived</option>
        </Select>
      </div>
      <div>
        <Label>Amount (USD)</Label>
        <Input
          type="number"
          step="0.01"
          min="0.5"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
      </div>
      <div className="md:col-span-2">
        <Label>Description (visible to user)</Label>
        <Textarea
          rows={2}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="e.g. Late submission penalty for Week 2 assignment"
        />
      </div>
      <div className="md:col-span-2 flex items-center gap-3">
        <Button onClick={submit} disabled={pending}>
          {pending ? "Issuing…" : `Issue ${kind}`}
        </Button>
        {okMsg && <span className="text-xs text-emerald-700 dark:text-emerald-300">{okMsg}</span>}
      </div>
      {error && <FieldError>{error}</FieldError>}
    </div>
  );
}
