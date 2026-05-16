"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Input,
  Label,
  Textarea,
  FieldError,
} from "@/components/ui/input";
import { Toggle } from "@/components/ui/toggle";
import { createOffer } from "@/app/dashboard/team/offers/actions";
import { getActionError } from "@/lib/action-error";

export function SafeOfferForm({ teamId }: { teamId: string }) {
  const router = useRouter();
  const [amount, setAmount] = useState<string>("");
  const [cap, setCap] = useState<string>("");
  const [discount, setDiscount] = useState<string>("");
  const [mfn, setMfn] = useState(false);
  const [proRata, setProRata] = useState(false);
  const [notes, setNotes] = useState("");
  const [sig, setSig] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | undefined>();
  const [okMsg, setOkMsg] = useState<string | undefined>();

  function submit() {
    setError(undefined);
    setOkMsg(undefined);
    if (!confirm) {
      setError("Confirm the legal acknowledgement first.");
      return;
    }
    const amt = Math.round(Number(amount) * 100);
    if (!Number.isFinite(amt) || amt <= 0) {
      setError("Amount must be a positive number.");
      return;
    }
    start(async () => {
      try {
        const id = await createOffer({
          teamId,
          amountCents: amt,
          valuationCapCents:
            cap.trim() === "" ? null : Math.round(Number(cap) * 100),
          discountPct: discount.trim() === "" ? null : Number(discount),
          mfn,
          proRata,
          notes: notes.trim() || null,
          signatureName: sig.trim(),
        });
        setOkMsg(`Offer sent.`);
        router.push(`/dashboard/team/offers/${id}`);
        router.refresh();
      } catch (e) {
        setError(getActionError(e));
      }
    });
  }

  return (
    <Card>
      <h3 className="text-base font-semibold">Send a SAFE</h3>
      <p className="text-xs text-white/50">
        Drafts a SAFE memo, signs as you, and emails the team for counter-
        signature. SparkLine Youth logs every signature in an audit trail.
      </p>
      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        <div>
          <Label>Amount (USD)</Label>
          <Input
            type="number"
            min={1}
            step={1}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="e.g. 25000"
          />
        </div>
        <div>
          <Label>Valuation cap (USD)</Label>
          <Input
            type="number"
            min={0}
            step={1}
            value={cap}
            onChange={(e) => setCap(e.target.value)}
            placeholder="e.g. 5000000"
          />
        </div>
        <div>
          <Label>Discount %</Label>
          <Input
            type="number"
            min={0}
            max={100}
            step={0.5}
            value={discount}
            onChange={(e) => setDiscount(e.target.value)}
            placeholder="e.g. 20"
          />
        </div>
        <div className="flex flex-col gap-3">
          <Toggle
            label="MFN"
            description="Match better terms given in future SAFEs."
            checked={mfn}
            onChange={setMfn}
          />
          <Toggle
            label="Pro-rata"
            description="Right to invest in future priced rounds."
            checked={proRata}
            onChange={setProRata}
          />
        </div>
        <div className="sm:col-span-2">
          <Label>Notes / side terms</Label>
          <Textarea
            rows={3}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Optional. Anything off-template."
          />
        </div>
        <div className="sm:col-span-2">
          <Label>Sign as</Label>
          <Input
            value={sig}
            onChange={(e) => setSig(e.target.value)}
            placeholder="Type your full legal name"
          />
          <label className="mt-3 flex items-start gap-2 text-xs text-white/70">
            <input
              type="checkbox"
              checked={confirm}
              onChange={(e) => setConfirm(e.target.checked)}
              className="mt-0.5"
            />
            I'm sending this as a binding offer the team can counter-sign.
            SparkLine Youth logs my signature with timestamp + IP.
          </label>
        </div>
      </div>
      {error && (
        <div className="mt-3">
          <FieldError>{error}</FieldError>
        </div>
      )}
      {okMsg && <p className="mt-3 text-xs text-emerald-300">{okMsg}</p>}
      <div className="mt-4 flex justify-end">
        <Button onClick={submit} disabled={pending || !sig.trim() || !amount}>
          {pending ? "Sending…" : "Send SAFE offer"}
        </Button>
      </div>
    </Card>
  );
}
