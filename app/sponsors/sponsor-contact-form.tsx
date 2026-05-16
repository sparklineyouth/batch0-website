"use client";

import { useState } from "react";
import { TIERS } from "./tiers";

const CONTACT_EMAIL = "sparklineyouth@gmail.com";

export function SponsorContactForm() {
  const [name, setName] = useState("");
  const [company, setCompany] = useState("");
  const [email, setEmail] = useState("");
  const [tier, setTier] = useState<string>(TIERS[1]?.name ?? "");
  const [message, setMessage] = useState("");

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const subject = `Sponsorship inquiry — ${company || name || "SparkLine Youth"}`;
    const body = [
      `Name: ${name}`,
      `Company: ${company}`,
      `Email: ${email}`,
      `Tier interest: ${tier}`,
      "",
      "Message:",
      message,
    ].join("\n");
    const href = `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    window.location.href = href;
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-4 sm:grid-cols-2">
      <Field
        label="Name"
        required
        className="sm:col-span-1"
        input={
          <input
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2.5 text-sm text-white placeholder:text-white/30 focus:border-spark/40 focus:outline-none focus:ring-1 focus:ring-spark/30"
            placeholder="Your name"
          />
        }
      />
      <Field
        label="Company"
        required
        className="sm:col-span-1"
        input={
          <input
            required
            value={company}
            onChange={(e) => setCompany(e.target.value)}
            className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2.5 text-sm text-white placeholder:text-white/30 focus:border-spark/40 focus:outline-none focus:ring-1 focus:ring-spark/30"
            placeholder="Company or organization"
          />
        }
      />
      <Field
        label="Email"
        required
        className="sm:col-span-1"
        input={
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2.5 text-sm text-white placeholder:text-white/30 focus:border-spark/40 focus:outline-none focus:ring-1 focus:ring-spark/30"
            placeholder="you@company.com"
          />
        }
      />
      <Field
        label="Tier interest"
        className="sm:col-span-1"
        input={
          <select
            value={tier}
            onChange={(e) => setTier(e.target.value)}
            className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2.5 text-sm text-white focus:border-spark/40 focus:outline-none focus:ring-1 focus:ring-spark/30"
          >
            {TIERS.map((t) => (
              <option key={t.name} value={`${t.name} (${t.price})`}>
                {t.name} ({t.price})
              </option>
            ))}
            <option value="Custom / not sure yet">Custom / not sure yet</option>
          </select>
        }
      />
      <Field
        label="Message"
        className="sm:col-span-2"
        input={
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            rows={5}
            className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2.5 text-sm text-white placeholder:text-white/30 focus:border-spark/40 focus:outline-none focus:ring-1 focus:ring-spark/30"
            placeholder="Anything else we should know? Goals, timing, questions."
          />
        }
      />
      <div className="sm:col-span-2 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-white/55">
          Opens your mail client. We reply within 2 business days.
        </p>
        <button
          type="submit"
          className="press inline-flex items-center justify-center gap-2 rounded-lg bg-spark px-5 py-3 text-[14px] font-semibold text-black shadow-[0_8px_24px_-8px_rgba(250,204,21,0.5)] hover:bg-spark-200"
        >
          Send inquiry
          <span aria-hidden>→</span>
        </button>
      </div>
    </form>
  );
}

function Field({
  label,
  input,
  required,
  className = "",
}: {
  label: string;
  input: React.ReactNode;
  required?: boolean;
  className?: string;
}) {
  return (
    <label className={`block ${className}`}>
      <span className="mb-1.5 block text-[11px] font-medium uppercase tracking-[0.16em] text-white/55">
        {label}
        {required && <span aria-hidden className="ml-1 text-spark">*</span>}
      </span>
      {input}
    </label>
  );
}
