"use client";
import * as React from "react";

export function Toggle({
  label,
  description,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-xl border border-white/10 bg-black/30 px-4 py-3.5">
      <div className="min-w-0">
        <div className="text-sm font-medium text-white">{label}</div>
        {description && (
          <p className="mt-1 text-xs text-white/50">{description}</p>
        )}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative h-6 w-11 shrink-0 rounded-full transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-spark/60 ${
          checked ? "bg-spark" : "bg-white/15"
        } ${disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"}`}
      >
        <span
          className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition ${
            checked ? "left-[calc(100%-1.375rem)]" : "left-0.5"
          }`}
        />
      </button>
    </div>
  );
}
