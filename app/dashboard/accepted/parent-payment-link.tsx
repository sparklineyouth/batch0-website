"use client";
import { useState } from "react";
import { easternDeadline, formatUsd } from "@/lib/offer-format";

export function ParentPaymentLink({ applicationId, parentInfoHref }: { applicationId: string; parentInfoHref: string }) {
  const [invitation, setInvitation] = useState<{ url: string; expiresAt: string; amountCents: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  async function createLink() {
    setBusy(true); setError(""); setCopied(false);
    try {
      const response = await fetch("/api/stripe/payer-link", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ applicationId }), cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not create a payment link.");
      setInvitation(data);
    } catch (err) { setError(err instanceof Error ? err.message : "Could not create a payment link."); }
    finally { setBusy(false); }
  }
  async function copy() {
    if (!invitation) return;
    try { await navigator.clipboard.writeText(invitation.url); setCopied(true); }
    catch { setError("Copy the link from the field below and share it privately with your parent or guardian."); }
  }
  return <section className="mt-6 border-t border-line pt-6">
    <h3 className="text-sm font-semibold">Is a parent or guardian paying?</h3>
    <p className="mt-2 text-sm leading-relaxed text-ink-soft">Share the <a href={parentInfoHref} className="link-ink">parent guide and calendar</a>, then create a secure payment invitation. They can pay without your password or application answers. Creating the link does not send a message.</p>
    <button onClick={createLink} disabled={busy} className="mt-4 rounded-md border border-line px-4 py-2 text-sm font-medium hover:border-ink/40 disabled:opacity-50">{busy ? "Creating invitation…" : invitation ? "Create a replacement link" : "Create parent payment link"}</button>
    {invitation && <div className="mt-4" data-sentry-mask>
      <label htmlFor="parent-payment-url" className="text-xs text-ink-soft">Private payment link · {formatUsd(invitation.amountCents)} · expires {easternDeadline(invitation.expiresAt)}</label>
      <input id="parent-payment-url" readOnly value={invitation.url} onFocus={event => event.target.select()} className="mt-2 w-full rounded-md border border-line bg-paper px-3 py-2 text-sm" />
      <button onClick={copy} className="mt-3 rounded-md bg-phosphor px-4 py-2 text-sm font-semibold text-on-phosphor">{copied ? "Copied" : "Copy private link"}</button>
      <p className="mt-2 text-xs text-ink-soft">A replacement link invalidates the previous one. Share only with the person paying.</p>
    </div>}
    <p role="status" aria-live="polite" className="mt-2 text-xs text-ink-soft">{error || (copied ? "Payment link copied. You can now share it privately." : "")}</p>
  </section>;
}
