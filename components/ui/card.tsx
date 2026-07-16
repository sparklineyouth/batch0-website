import * as React from "react";

export function Card({
  className = "",
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`rounded-2xl border border-line bg-wash p-6 ${className}`}
    >
      {children}
    </div>
  );
}

export function CardHeader({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-5 flex items-start justify-between gap-4">
      <div>
        <h3 className="font-display text-lg font-semibold tracking-[-0.02em] text-ink">
          {title}
        </h3>
        {description && (
          <p className="mt-1 text-sm text-ink-soft">{description}</p>
        )}
      </div>
      {action}
    </div>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    draft: "bg-wash text-ink-soft",
    submitted: "bg-blue-400/15 text-blue-300",
    accepted: "bg-emerald-400/15 text-emerald-300",
    waitlisted: "bg-amber-400/15 text-amber-300",
    rejected: "bg-red-400/15 text-red-300",
    paid: "bg-phosphor/15 text-phosphor-ink",
    enrolled: "bg-phosphor/15 text-phosphor-ink",
    withdrawn: "bg-wash text-ink-faint",
    succeeded: "bg-emerald-400/15 text-emerald-300",
    pending: "bg-amber-400/15 text-amber-300",
    failed: "bg-red-400/15 text-red-300",
    refunded: "bg-wash text-ink-soft",
    upcoming: "bg-blue-400/15 text-blue-300",
    active: "bg-emerald-400/15 text-emerald-300",
    completed: "bg-wash text-ink-soft",
    cancelled: "bg-red-400/15 text-red-300",
  };
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-mono font-medium uppercase tracking-wider ${
        colors[status] || "bg-wash text-ink-soft"
      }`}
    >
      {status}
    </span>
  );
}
