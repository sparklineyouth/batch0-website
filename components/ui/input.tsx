import * as React from "react";

// `text-base md:text-sm` gives mobile users 16px (which iOS Safari needs
// to NOT auto-zoom when focusing a field) and keeps the denser 14px on
// medium-and-up where touch isn't the primary input mode.
export const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(function Input({ className = "", ...props }, ref) {
  return (
    <input
      ref={ref}
      className={`h-10 w-full rounded-lg border border-white/10 bg-black/40 px-3 text-base text-white placeholder:text-white/30 focus:border-spark/60 focus:outline-none focus:ring-2 focus:ring-spark/30 md:text-sm ${className}`}
      {...props}
    />
  );
});

export const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea({ className = "", ...props }, ref) {
  return (
    <textarea
      ref={ref}
      className={`min-h-24 w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-base text-white placeholder:text-white/30 focus:border-spark/60 focus:outline-none focus:ring-2 focus:ring-spark/30 md:text-sm ${className}`}
      {...props}
    />
  );
});

export const Select = React.forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement>
>(function Select({ className = "", children, ...props }, ref) {
  return (
    <select
      ref={ref}
      className={`h-10 w-full rounded-lg border border-white/10 bg-black/40 px-3 text-base text-white focus:border-spark/60 focus:outline-none focus:ring-2 focus:ring-spark/30 md:text-sm ${className}`}
      {...props}
    >
      {children}
    </select>
  );
});

export function Label({
  children,
  htmlFor,
  className = "",
}: {
  children: React.ReactNode;
  htmlFor?: string;
  className?: string;
}) {
  return (
    <label
      htmlFor={htmlFor}
      className={`mb-1.5 block text-xs font-medium uppercase tracking-wider text-white/60 ${className}`}
    >
      {children}
    </label>
  );
}

export function FieldError({ children }: { children?: React.ReactNode }) {
  if (!children) return null;
  return <p className="mt-1 text-xs text-red-400">{children}</p>;
}
