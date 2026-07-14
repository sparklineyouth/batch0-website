import * as React from "react";

// Inputs accept an optional `error` flag/string. When set we wire
// aria-invalid + aria-describedby (pointing at `${id}-error`), and
// bump the visible border to red so the issue is obvious to sighted
// users. The matching error text is rendered by <FieldError id="..."/>
// rendered by the caller — keeping markup flexible while making the
// association explicit for assistive tech.
type CommonProps = {
  /** Truthy = invalid. Pass the message string so we don't render the
   *  error text twice (callers already render <FieldError>) while still
   *  driving the visual + ARIA invalid state from one prop. */
  error?: string | boolean | null;
};

function describedBy(error: CommonProps["error"], id: string | undefined, extra?: string) {
  const parts: string[] = [];
  if (error && id) parts.push(`${id}-error`);
  if (extra) parts.push(extra);
  return parts.length ? parts.join(" ") : undefined;
}

// Solid red border + soft red ring + faint red tint on the background.
// Without all three, the invalid state was easy to miss against a dark
// black/40 surface — "Please fix the highlighted fields" had nothing
// visible to point at.
const ERROR_CLASSES =
  "border-red-400 ring-1 ring-red-400/40 bg-red-400/[0.06]";
const NEUTRAL_BORDER = "border-line";

// `text-base md:text-sm` gives mobile users 16px (which iOS Safari needs
// to NOT auto-zoom when focusing a field) and keeps the denser 14px on
// medium-and-up where touch isn't the primary input mode.
export const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement> & CommonProps
>(function Input(
  { className = "", error, id, "aria-describedby": ariaDescribedBy, ...props },
  ref,
) {
  const state = error ? ERROR_CLASSES : `${NEUTRAL_BORDER} bg-paper`;
  return (
    <input
      ref={ref}
      id={id}
      aria-invalid={error ? true : undefined}
      aria-describedby={describedBy(error, id, ariaDescribedBy)}
      data-invalid={error ? true : undefined}
      className={`h-10 w-full rounded-md border ${state} px-3 text-base text-ink placeholder:text-ink-faint focus:border-phosphor focus:outline-none focus:ring-2 focus:ring-phosphor/30 md:text-sm ${className}`}
      {...props}
    />
  );
});

export const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement> & CommonProps
>(function Textarea(
  { className = "", error, id, "aria-describedby": ariaDescribedBy, ...props },
  ref,
) {
  const state = error ? ERROR_CLASSES : `${NEUTRAL_BORDER} bg-paper`;
  return (
    <textarea
      ref={ref}
      id={id}
      aria-invalid={error ? true : undefined}
      aria-describedby={describedBy(error, id, ariaDescribedBy)}
      data-invalid={error ? true : undefined}
      className={`min-h-24 w-full rounded-md border ${state} px-3 py-2 text-base text-ink placeholder:text-ink-faint focus:border-phosphor focus:outline-none focus:ring-2 focus:ring-phosphor/30 md:text-sm ${className}`}
      {...props}
    />
  );
});

export const Select = React.forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement> & CommonProps
>(function Select(
  { className = "", children, error, id, "aria-describedby": ariaDescribedBy, ...props },
  ref,
) {
  const state = error ? ERROR_CLASSES : `${NEUTRAL_BORDER} bg-paper`;
  return (
    <select
      ref={ref}
      id={id}
      aria-invalid={error ? true : undefined}
      aria-describedby={describedBy(error, id, ariaDescribedBy)}
      data-invalid={error ? true : undefined}
      className={`h-10 w-full rounded-md border ${state} px-3 text-base text-ink focus:border-phosphor focus:outline-none focus:ring-2 focus:ring-phosphor/30 md:text-sm ${className}`}
      {...props}
    >
      {children}
    </select>
  );
});

export function Label({
  children,
  htmlFor,
  required,
  className = "",
}: {
  children: React.ReactNode;
  htmlFor?: string;
  /** When true, append a visually-hidden "required" cue so screen
   *  readers don't announce the visible `*` as "asterisk." */
  required?: boolean;
  className?: string;
}) {
  return (
    <label
      htmlFor={htmlFor}
      className={`mb-1.5 block text-xs font-mono font-medium uppercase tracking-wider text-ink-soft ${className}`}
    >
      {children}
      {required && <span className="sr-only"> required</span>}
    </label>
  );
}

export function FieldError({
  children,
  id,
}: {
  children?: React.ReactNode;
  /** Pair with the matching input's `id+"-error"` so aria-describedby
   *  on the input can point at this element. */
  id?: string;
}) {
  if (!children) return null;
  return (
    <p
      id={id}
      role="alert"
      className="mt-1 text-xs text-red-300"
    >
      {children}
    </p>
  );
}
