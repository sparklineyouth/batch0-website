"use client";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input, Label, FieldError } from "@/components/ui/input";
import { createClient } from "@/lib/supabase/client";
import { CheckCircle2, ShieldOff, ShieldCheck } from "lucide-react";
import { getActionError } from "@/lib/action-error";

type Factor = {
  id: string;
  status: string;
  friendly_name?: string | null;
};

export function MfaManager() {
  const [factors, setFactors] = useState<Factor[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  // Enroll/verify state
  const [enrollFactor, setEnrollFactor] = useState<{
    id: string;
    qr: string;
    secret: string;
  } | null>(null);
  const [code, setCode] = useState("");
  const [verified, setVerified] = useState(false);

  async function refresh() {
    setErr(undefined);
    setLoading(true);
    try {
      const supabase = createClient();
      const { data, error } = await supabase.auth.mfa.listFactors();
      if (error) throw error;
      const all: Factor[] = [
        ...((data?.totp as any[]) ?? []),
      ];
      setFactors(all);
    } catch (e: any) {
      setErr(getActionError(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function startEnroll() {
    setErr(undefined);
    setBusy(true);
    try {
      const supabase = createClient();
      const { data, error } = await supabase.auth.mfa.enroll({
        factorType: "totp",
        friendlyName: "SparkLine admin",
      });
      if (error) throw error;
      setEnrollFactor({
        id: data.id,
        qr: (data as any).totp?.qr_code ?? "",
        secret: (data as any).totp?.secret ?? "",
      });
    } catch (e: any) {
      setErr(getActionError(e));
    } finally {
      setBusy(false);
    }
  }

  async function verify() {
    if (!enrollFactor) return;
    setErr(undefined);
    setBusy(true);
    try {
      const supabase = createClient();
      const { data: chal, error: cErr } = await supabase.auth.mfa.challenge({
        factorId: enrollFactor.id,
      });
      if (cErr) throw cErr;
      const { error: vErr } = await supabase.auth.mfa.verify({
        factorId: enrollFactor.id,
        challengeId: chal.id,
        code: code.trim(),
      });
      if (vErr) throw vErr;
      // Record the step-up so subsequent sensitive actions go through.
      await fetch("/api/mfa/record", { method: "POST" });
      setEnrollFactor(null);
      setCode("");
      setVerified(true);
      await refresh();
    } catch (e: any) {
      setErr(getActionError(e));
    } finally {
      setBusy(false);
    }
  }

  async function stepUp(factorId: string) {
    setErr(undefined);
    setBusy(true);
    try {
      const supabase = createClient();
      const { data: chal, error: cErr } = await supabase.auth.mfa.challenge({
        factorId,
      });
      if (cErr) throw cErr;
      const { error: vErr } = await supabase.auth.mfa.verify({
        factorId,
        challengeId: chal.id,
        code: code.trim(),
      });
      if (vErr) throw vErr;
      await fetch("/api/mfa/record", { method: "POST" });
      setVerified(true);
      setCode("");
    } catch (e: any) {
      setErr(getActionError(e));
    } finally {
      setBusy(false);
    }
  }

  async function unenroll(id: string) {
    if (!confirm("Remove this factor? You'll need to re-enroll later.")) return;
    setErr(undefined);
    setBusy(true);
    try {
      const supabase = createClient();
      const { error } = await supabase.auth.mfa.unenroll({ factorId: id });
      if (error) throw error;
      await refresh();
    } catch (e: any) {
      setErr(getActionError(e));
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return <p className="text-sm text-white/40">Loading…</p>;
  }

  const verifiedFactor = factors.find((f) => f.status === "verified");

  return (
    <div className="space-y-5">
      <FieldError>{err}</FieldError>

      {verifiedFactor ? (
        <>
          <div className="flex items-start gap-3 rounded-lg border border-emerald-400/30 bg-emerald-400/10 px-3 py-2">
            <ShieldCheck className="mt-0.5 h-4 w-4 text-emerald-300" />
            <div className="text-sm text-emerald-100">
              TOTP enrolled. Sensitive admin actions are now MFA-gated.
            </div>
          </div>

          <div>
            <Label>Step up now</Label>
            <div className="flex flex-wrap gap-2">
              <Input
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\s/g, ""))}
                placeholder="6-digit code"
                inputMode="numeric"
                maxLength={6}
                className="max-w-[10rem]"
              />
              <Button
                onClick={() => stepUp(verifiedFactor.id)}
                disabled={busy || code.length < 6}
              >
                {busy ? "Verifying…" : "Verify"}
              </Button>
            </div>
            {verified && (
              <p className="mt-2 inline-flex items-center gap-1 text-xs text-emerald-300">
                <CheckCircle2 className="h-3 w-3" /> Stepped up — good for 15 minutes.
              </p>
            )}
          </div>

          <div className="border-t border-white/10 pt-4">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => unenroll(verifiedFactor.id)}
              disabled={busy}
            >
              <ShieldOff className="h-3.5 w-3.5" /> Remove factor
            </Button>
          </div>
        </>
      ) : enrollFactor ? (
        <div className="space-y-4">
          <p className="text-sm text-white/70">
            Scan this QR with your authenticator app, then enter the 6-digit
            code below to verify.
          </p>
          {enrollFactor.qr && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={enrollFactor.qr}
              alt="TOTP QR"
              className="h-44 w-44 rounded-lg border border-white/10 bg-white p-2"
            />
          )}
          {enrollFactor.secret && (
            <p className="text-xs text-white/40">
              Or paste this secret manually:{" "}
              <code className="font-mono">{enrollFactor.secret}</code>
            </p>
          )}
          <div>
            <Label>6-digit code</Label>
            <Input
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\s/g, ""))}
              maxLength={6}
              inputMode="numeric"
              className="max-w-[10rem]"
            />
          </div>
          <div className="flex gap-2">
            <Button onClick={verify} disabled={busy || code.length < 6}>
              {busy ? "Verifying…" : "Verify + enroll"}
            </Button>
            <Button
              variant="ghost"
              onClick={() => setEnrollFactor(null)}
              disabled={busy}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex items-start gap-3 rounded-lg border border-amber-300/30 bg-amber-300/10 px-3 py-2">
            <ShieldOff className="mt-0.5 h-4 w-4 text-amber-200" />
            <div className="text-sm text-amber-100">
              No factor enrolled. Enroll one now — until you do, sensitive
              actions are *not* protected.
            </div>
          </div>
          <Button onClick={startEnroll} disabled={busy}>
            {busy ? "Working…" : "Enroll TOTP"}
          </Button>
        </div>
      )}
    </div>
  );
}
