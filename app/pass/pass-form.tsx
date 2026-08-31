"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input, Label, FieldError } from "@/components/ui/input";
import { Loader2 } from "lucide-react";
import {
  clearStashedPassCode,
  readPassCodeFromLocation,
  readStashedPassCode,
  stashPassCode,
} from "@/lib/pass-code";
import { redeemPassAction } from "./actions";
import { VirtualPassCard } from "./virtual-pass-card";

/**
 * Two experiences in one component, chosen by whether a code arrived with the
 * visitor:
 *
 *   ARRIVAL — they clicked "Redeem your pass" in a virtual-pass email, so the
 *             code is in the URL. They see the golden card with their code on
 *             it and never touch the keyboard: signed in, it redeems itself;
 *             signed out, one button takes them through signup and it redeems
 *             on the way back.
 *
 *   MANUAL  — they're holding a printed card and typing what's embossed on it.
 *             The original form, unchanged.
 *
 * Both run the SAME submit() and the same server action. That's deliberate:
 * redemption is rate-limited and one-shot, and a second code path would be a
 * second place for those rules to drift.
 */
export function PassForm({ signedIn }: { signedIn: boolean }) {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);

  // Whether the code came from a link/stash rather than the keyboard — i.e.
  // whether this is the arrival experience. Undefined until the mount effect
  // has looked, so the first paint doesn't flash the manual form at someone
  // who came from an email.
  const [arrived, setArrived] = useState<boolean | undefined>(undefined);

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

  // Pick the code up from ?code= (the email's redeem link, or a QR on a
  // printed card) or from the stash left behind before the signup bounce, and
  // — if we're now signed in — redeem it without making them press anything.
  useEffect(() => {
    if (autoTried.current) return;
    const fromUrl = readPassCodeFromLocation();
    const stashed = readStashedPassCode();
    const found = fromUrl || stashed;
    if (!found) {
      setArrived(false);
      return;
    }

    setCode(found);
    setArrived(true);
    if (signedIn) {
      autoTried.current = true;
      void submit(found);
    }
    // submit is stable enough for this one-shot mount effect; adding it to the
    // deps would re-run on every keystroke via the `code` state it closes over.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedIn]);

  // ------------------------------------------------------------------ arrival
  if (arrived) {
    // A failed auto-redeem falls back to the manual form BELOW the card, with
    // the code already filled in — the code is still visible on the card, so
    // nobody is ever stuck without it.
    const failed = !!error;
    return (
      <div>
        <VirtualPassCard code={code} className="mx-auto max-w-sm" />

        <div className="mt-8 text-center">
          {loading ? (
            <p className="inline-flex items-center gap-2 text-sm text-ink-soft">
              <Loader2 className="h-4 w-4 animate-spin text-phosphor-ink" />
              Binding this pass to your account…
            </p>
          ) : !signedIn ? (
            <>
              <p className="text-sm text-ink-soft">
                This pass is yours — it just needs an account to live on. Your
                code is already saved; you won&apos;t have to type it.
              </p>
              <Button
                onClick={() => void submit(code)}
                size="lg"
                className="mt-4 w-full sm:w-auto"
              >
                Create your account and claim it
              </Button>
            </>
          ) : failed ? (
            <>
              <p className="text-sm text-red-600 dark:text-red-300">{error}</p>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void submit(code);
                }}
                className="mx-auto mt-5 max-w-xs text-left"
              >
                <Label htmlFor="pass-code">Card code</Label>
                <Input
                  id="pass-code"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  autoComplete="off"
                  autoCapitalize="characters"
                  spellCheck={false}
                  className="font-mono uppercase tracking-[0.2em]"
                />
                <Button type="submit" className="mt-3 w-full" disabled={loading}>
                  Try again
                </Button>
              </form>
            </>
          ) : (
            <p className="text-sm text-ink-soft">Checking your pass…</p>
          )}
        </div>
      </div>
    );
  }

  // ------------------------------------------------------------------- manual
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
