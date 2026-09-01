"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input, Textarea, Label, Select, FieldError } from "@/components/ui/input";
import { getActionError } from "@/lib/action-error";
import { RECEIPT_KINDS } from "@/lib/receipts";
import { postReceipt, deleteReceipt } from "./actions";
import { Send, Trash2 } from "lucide-react";

/** Tiny inline delete control — own receipts, or any receipt for admins. */
export function DeleteReceiptButton({ id }: { id: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      aria-label="Delete receipt"
      disabled={pending}
      onClick={() =>
        start(async () => {
          try {
            await deleteReceipt(id);
            router.refresh();
          } catch {
            /* leave the row; a refresh will reconcile */
          }
        })
      }
      className="rounded-md p-1 text-ink-faint hover:text-red-600 dark:hover:text-red-400 disabled:opacity-50"
    >
      <Trash2 className="h-3.5 w-3.5" />
    </button>
  );
}

export function ReceiptForm() {
  const router = useRouter();
  const [kind, setKind] = useState<string>("interview");
  const [body, setBody] = useState("");
  const [link, setLink] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [pending, start] = useTransition();

  const prompt =
    RECEIPT_KINDS.find((k) => k.value === kind)?.prompt ?? "";

  function submit() {
    setError(undefined);
    start(async () => {
      try {
        await postReceipt({ kind, body, linkUrl: link || null });
        setBody("");
        setLink("");
        router.refresh();
      } catch (e: any) {
        setError(getActionError(e));
      }
    });
  }

  return (
    <div className="rounded-xl border border-line bg-wash p-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor="receipt-kind">What did you do?</Label>
          <Select
            id="receipt-kind"
            value={kind}
            onChange={(e) => setKind(e.target.value)}
          >
            {RECEIPT_KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label htmlFor="receipt-link">Link (optional)</Label>
          <Input
            id="receipt-link"
            type="url"
            placeholder="https://…"
            value={link}
            onChange={(e) => setLink(e.target.value)}
          />
        </div>
      </div>
      <div className="mt-3">
        <Label htmlFor="receipt-body">The receipt</Label>
        <Textarea
          id="receipt-body"
          rows={3}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder={prompt}
        />
        <p className="mt-1 text-xs text-ink-faint">
          Evidence only — numbers, quotes, links. Strip out personal info
          (full names, phone numbers) before posting.
        </p>
      </div>
      {error && <FieldError>{error}</FieldError>}
      <div className="mt-3 flex justify-end">
        <Button onClick={submit} disabled={pending || !body.trim()}>
          {pending ? "Posting…" : "Post receipt"}
          <Send className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}
