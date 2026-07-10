"use client";

import { useState } from "react";
import { TIERS } from "./tiers";

export function SponsorContactForm({
  contactEmail,
}: {
  /** Admin-set contact from site_settings — same source as the footer. */
  contactEmail: string;
}) {
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
    const href = `mailto:${contactEmail}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
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
            className="w-full rounded-md border border-line bg-paper px-3 py-2.5 text-sm text-ink placeholder:text-ink-faint focus:border-spark-400 focus:outline-none focus:ring-1 focus:ring-spark"
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
            className="w-full rounded-md border border-line bg-paper px-3 py-2.5 text-sm text-ink placeholder:text-ink-faint focus:border-spark-400 focus:outline-none focus:ring-1 focus:ring-spark"
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
            className="w-full rounded-md border border-line bg-paper px-3 py-2.5 text-sm text-ink placeholder:text-ink-faint focus:border-spark-400 focus:outline-none focus:ring-1 focus:ring-spark"
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
            className="w-full rounded-md border border-line bg-paper px-3 py-2.5 text-sm text-ink focus:border-spark-400 focus:outline-none focus:ring-1 focus:ring-spark"
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
            className="w-full rounded-md border border-line bg-paper px-3 py-2.5 text-sm text-ink placeholder:text-ink-faint focus:border-spark-400 focus:outline-none focus:ring-1 focus:ring-spark"
            placeholder="Anything else we should know? Goals, timing, questions."
          />
        }
      />
      <div className="sm:col-span-2 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-ink-faint">
          Opens your mail client. We reply within 2 business days.
        </p>
        <button
          type="submit"
          className="press inline-flex items-center justify-center gap-2 rounded-md bg-spark px-5 py-3 text-[14px] font-semibold text-ink shadow-cta hover:bg-spark-200"
        >
          Send inquiry
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
      <span className="mb-1.5 block text-[13px] font-medium text-ink-soft">
        {label}
        {required && <span aria-hidden className="ml-0.5 text-spark-ink">*</span>}
      </span>
      {input}
    </label>
  );
}
