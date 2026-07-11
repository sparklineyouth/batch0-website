import * as React from "react";

type Props = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md" | "lg";
};

export const Button = React.forwardRef<HTMLButtonElement, Props>(function Button(
  { className = "", variant = "primary", size = "md", ...props },
  ref,
) {
  // Instant feedback: no easing on hover/active so the click "snaps".
  // Only the press scale animates, and via transform alone so it stays
  // composited on the GPU.
  // `whitespace-nowrap` keeps short labels like "Re-score" or "Waive & enroll"
  // on a single line when the button sits inside a narrow flex column —
  // without it the hyphen / ampersand becomes a soft wrap point.
  const base =
    "inline-flex select-none items-center justify-center gap-2 whitespace-nowrap rounded-md font-semibold leading-none active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-spark focus-visible:ring-offset-2 focus-visible:ring-offset-paper";
  const variants = {
    primary: "bg-spark text-on-spark shadow-cta hover:bg-spark-200",
    secondary:
      "bg-paper text-ink border border-line hover:border-ink/30 hover:bg-wash",
    ghost: "text-ink-soft hover:text-ink hover:bg-wash",
    danger: "bg-red-500 text-white hover:bg-red-600",
  } as const;
  const sizes = {
    sm: "h-8 px-3 text-xs",
    md: "h-10 px-4 text-sm",
    lg: "h-12 px-6 text-base",
  } as const;
  return (
    <button
      ref={ref}
      className={`${base} ${variants[variant]} ${sizes[size]} ${className}`}
      {...props}
    />
  );
});
