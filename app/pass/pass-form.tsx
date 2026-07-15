"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input, Label, FieldError } from "@/components/ui/input";
import {
  clearStashedPassCode,
  readPassCodeFromLocation,
  readStashedPassCode,
  stashPassCode,
} from "@/lib/pass-code";
import { redeemPassAction } from "./actions";

export function PassForm({ signedIn }: { signedIn: boolean }) {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);

  // Guards the auto-redeem effect below. A ref, not state: it must flip
  // synchronously on the first run, before React can schedule a second one
  // (StrictMode double-invokes effects in dev, and a state flag would let both
  // passes through and burn a rate-limit slot on a duplicate attempt).
  const autoTried = useRef(false);

  async function submit(raw: string) {
    const trimmed = raw.trim();
    if (!trimmed) {
      setError("Enter the code from your card.");
      return;
    }

    // Signed out: park the code and route through signup. A pass has to bind
    // to an account, so there's nothing to redeem against yet — but making
    // someone re-type an 8-character code off a piece of plastic after signup
    // is exactly how you lose them.
    if (!signedIn) {
      stashPassCode(trimmed);
      router.push(`/signup?next=${encodeURIComponent("/pass")}`);
      return;
    }

    setLoading(true);
    setError(undefined);
    const result = await redeemPassAction(trimmed);
    setLoading(false);

    // Clear on ANY terminal outcome, not just success: a code left in storage
    // after a failure re-fires on the next visit, which reads as the page
    // redeeming things on its own.
    clearStashedPassCode();

    if (result.ok) {
      // Server-rendered success state — page.tsx re-reads the pass and swaps
      // the form for the unlocked card, so there's one source of truth for
      // "do they hold a pass" rather than a client copy that can drift.
      router.refresh();
      return;
    }
    setError(result.message);
  }

  // Pick the code up from ?code= (a QR on the card) or from the stash left
  // behind before the signup bounce, and — if we're now signed in — redeem it
  // without making them press the button again.
  useEffect(() => {
    if (autoTried.current) return;
    const fromUrl = readPassCodeFromLocation();
    const stashed = readStashedPassCode();
    const found = fromUrl || stashed;
    if (!found) return;

    setCode(found);
    if (signedIn) {
      autoTried.current = true;
      void submit(found);
    }
    // submit is stable enough for this one-shot mount effect; adding it to the
    // deps would re-run on every keystroke via the `code` state it closes over.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedIn]);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit(code);
      }}
      className="mt-6"
    >
      <Label htmlFor="pass-code">Card code</Label>
      <Input
        id="pass-code"
        value={code}
        onChange={(e) => setCode(e.target.value)}
        error={error}
        placeholder="A39FK2"
        autoComplete="off"
        autoCapitalize="characters"
        spellCheck={false}
        // Codes are minted from an unambiguous alphabet and normalised
        // case-insensitively, so uppercase is purely cosmetic — it just
        // matches what's embossed on the card.
        className="font-mono uppercase tracking-[0.2em]"
      />
      <FieldError id="pass-code-error">{error}</FieldError>

      <Button type="submit" className="mt-4 w-full" disabled={loading} size="lg">
        {loading ? "Checking..." : signedIn ? "Unlock my pass" : "Continue"}
      </Button>

      {!signedIn && (
        <p className="mt-3 text-center text-xs text-ink-faint">
          You&apos;ll make an account next. We&apos;ll hold onto your code.
        </p>
      )}
    </form>
  );
}
