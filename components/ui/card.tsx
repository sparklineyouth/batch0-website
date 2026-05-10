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
      className={`rounded-2xl border border-white/10 bg-zinc-900/40 p-6 ${className}`}
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
        <h3 className="text-lg font-semibold text-white">{title}</h3>
        {description && (
          <p className="mt-1 text-sm text-white/50">{description}</p>
        )}
      </div>
      {action}
    </div>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    draft: "bg-white/10 text-white/60",
    submitted: "bg-blue-400/15 text-blue-300",
    accepted: "bg-emerald-400/15 text-emerald-300",
    rejected: "bg-red-400/15 text-red-300",
    paid: "bg-spark/15 text-spark",
    enrolled: "bg-spark/15 text-spark",
    withdrawn: "bg-white/10 text-white/40",
    succeeded: "bg-emerald-400/15 text-emerald-300",
    pending: "bg-amber-400/15 text-amber-300",
    failed: "bg-red-400/15 text-red-300",
    refunded: "bg-white/10 text-white/60",
    upcoming: "bg-blue-400/15 text-blue-300",
    active: "bg-emerald-400/15 text-emerald-300",
    completed: "bg-white/10 text-white/60",
    cancelled: "bg-red-400/15 text-red-300",
  };
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium uppercase tracking-wider ${
        colors[status] || "bg-white/10 text-white/60"
      }`}
    >
      {status}
    </span>
  );
}
