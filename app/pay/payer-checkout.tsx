"use client";
import { useEffect, useState } from "react";
import { easternDeadline, formatUsd } from "@/lib/offer-format";
import { formatDateSentence } from "@/lib/seo-meta";
import { payerReturnStatus } from "@/lib/payment-privacy";

declare global { interface Window { __batch0PayerToken?: string; __batch0CheckoutSession?: string } }
type Quote = {
  cohortId: string; cohortName: string; amountCents: number; currency: string; expiresAt: string;
  startDate: string | null; endDate: string | null;
  lateEntryUntil: string | null; catchUpPlan: string | null;
};

export function PayerCheckout() {
  const [token, setToken] = useState<string | null>(null);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [loading, setLoading] = useState(true);
  const [paying, setPaying] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [consent, setConsent] = useState(false);
  async function verifyPayment() {
    const sessionId = window.__batch0CheckoutSession;
    if (!sessionId) return;
    setLoading(true); setError("");
    try {
      const response = await fetch("/api/stripe/payer-status", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId }), cache: "no-store", referrerPolicy: "no-referrer",
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "We could not verify the payment yet.");
      setStatus(["confirmed", "pending", "review"].includes(data.status) ? data.status : "pending");
    } catch (err) { setStatus("pending"); setError(err instanceof Error ? err.message : "We could not verify the payment yet."); }
    finally { setLoading(false); }
  }

  useEffect(() => {
    let active = true;
    const queryStatus = new URLSearchParams(window.location.search).get("status");
    const status = payerReturnStatus(queryStatus);
    setStatus(status);
    if (window.__batch0CheckoutSession) { void verifyPayment(); return; }
    // The inline root script captured and removed the fragment before any
    // analytics could initialize. Memory only: no cookie or local storage.
    const invitation = window.__batch0PayerToken ?? null;
    setToken(invitation);
    if (!invitation) { setLoading(false); return; }
    fetch("/api/stripe/payer-quote", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: invitation }), cache: "no-store", referrerPolicy: "no-referrer",
    }).then(async response => {
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "This invitation is no longer available.");
      if (active) setQuote(data);
    }).catch(err => { if (active) setError(err instanceof Error ? err.message : "Could not load this invitation."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  async function pay() {
    if (!token || !consent || paying) return;
    setPaying(true); setError("");
    try {
      const response = await fetch("/api/stripe/payer-checkout", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }), cache: "no-store", referrerPolicy: "no-referrer",
      });
      const data = await response.json();
      if (!response.ok || !data.url) throw new Error(data.error || "Could not open checkout. Please try again.");
      const destination = new URL(data.url);
      // Only the server's Stripe Checkout URL is an allowed external redirect.
      if (destination.protocol !== "https:" || destination.hostname !== "checkout.stripe.com") throw new Error("Checkout could not be verified. Please contact the team.");
      window.location.assign(destination.href);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not open checkout.");
      setPaying(false);
    }
  }

  if (loading) return <p role="status" className="mt-12 text-sm text-ink-soft">Checking your enrollment details…</p>;
  if (!token || !quote) return <section className="mt-10">
    <h1 className="font-display text-4xl">{status === "confirmed" ? "Enrollment is confirmed." : status === "review" ? "Payment received. The team is reviewing enrollment." : ["complete", "pending"].includes(status) ? "We are checking the payment." : status === "canceled" ? "Checkout was canceled." : "Open your student’s payment invitation."}</h1>
    <p className="mt-5 text-sm leading-relaxed text-ink-soft">{status === "confirmed"
      ? "Batch0 verified the payment with Stripe and confirmed the student’s enrollment. The student can now open their dashboard."
      : status === "review"
        ? "Payment has been received, but enrollment needs a team review. Please contact hello@batch0.org with the receipt. Do not make another payment."
        : ["complete", "pending"].includes(status)
          ? "Enrollment is not confirmed yet. Check again in a moment, or have the student check their dashboard. Do not make another payment while verification is pending."
      : status === "canceled"
        ? "To try again, reopen the original invitation shared by your student. If it has expired, they can create a new one from their acceptance page."
        : error || "Ask your accepted student to open their acceptance page, create a parent payment link and share it with you. You do not need their password or a Batch0 account."}</p>
    {status === "pending" && typeof window !== "undefined" && window.__batch0CheckoutSession && <button onClick={verifyPayment} className="mt-5 rounded-md border border-line px-4 py-2 text-sm">Check payment status again</button>}
    {error && <p role="alert" className="mt-4 text-sm text-red-700 dark:text-red-300">{error}</p>}
    <p className="mt-5 text-sm leading-relaxed text-ink-soft">If you paid but the enrollment has not updated, email <a className="link-ink" href="mailto:hello@batch0.org">hello@batch0.org</a> with your receipt. Do not make a second payment while it is being checked.</p>
    <div className="mt-6 flex flex-wrap gap-5 text-sm"><a href="/dashboard" className="link-ink">Student dashboard →</a><a href="/parents" className="link-ink">Program information for parents →</a></div>
  </section>;

  const dates = formatDateSentence(quote.startDate, quote.endDate);
  return <section className="mt-10">
    <p className="text-xs uppercase tracking-wider text-ink-faint">Enrollment invitation</p>
    <h1 className="mt-3 font-display text-4xl">Help your student get started.</h1>
    <p className="mt-5 text-sm leading-relaxed text-ink-soft">This invitation is for an accepted student. You can pay from your own device, without accessing their account or application answers.</p>
    <dl className="mt-8 border-t border-line text-sm">
      {[["Cohort", quote.cohortName], ["Dates", dates || "Contact the team before enrolling"], ["One-time tuition", `${formatUsd(quote.amountCents)} USD`], ["Invitation expires", easternDeadline(quote.expiresAt)]].map(([label, value]) => <div key={label} className="flex flex-wrap justify-between gap-3 border-b border-line py-4"><dt className="text-ink-soft">{label}</dt><dd className="font-semibold">{value}</dd></div>)}
    </dl>
    {quote.catchUpPlan && quote.lateEntryUntil && <div className="mt-6 border-l-2 border-phosphor bg-wash p-4 text-sm leading-relaxed"><p className="font-semibold">This cohort has started. Late entry ends {easternDeadline(quote.lateEntryUntil)}.</p><p className="mt-2 text-ink-soft">{quote.catchUpPlan}</p></div>}
    <p className="mt-6 text-sm leading-relaxed text-ink-soft">Review the <a href={`/parents?cohort=${encodeURIComponent(quote.cohortId)}`} target="_blank" rel="noopener noreferrer" className="link-ink">program and live schedule</a> before paying. The final charge is shown again on Stripe; enrollment is confirmed after payment verification.</p>
    <label className="mt-6 flex items-start gap-3 text-sm leading-relaxed"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} className="mt-1 h-4 w-4 accent-[#FFBB00]" /><span>I have reviewed the <a className="link-ink" href="/terms" target="_blank" rel="noopener noreferrer">terms</a> and <a className="link-ink" href="/refund-policy" target="_blank" rel="noopener noreferrer">refund policy</a> for this enrollment.</span></label>
    <button onClick={pay} disabled={!consent || paying} aria-busy={paying} className="mt-6 w-full rounded-md bg-phosphor px-5 py-3.5 text-sm font-semibold text-on-phosphor disabled:cursor-not-allowed disabled:opacity-50">{paying ? "Opening secure checkout…" : `Continue to Stripe · ${formatUsd(quote.amountCents)}`}</button>
    {error && <p role="alert" className="mt-4 text-sm text-red-700 dark:text-red-300">{error}</p>}
    <p className="mt-4 text-xs leading-relaxed text-ink-soft">Keep this invitation private. It permits payment for this student’s enrollment and expires automatically.</p>
  </section>;
}
