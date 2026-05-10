import * as React from "react";

type Props = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md" | "lg";
};

export function Button({
  className = "",
  variant = "primary",
  size = "md",
  ...props
}: Props) {
  const base =
    "inline-flex items-center justify-center gap-2 rounded-lg font-medium transition disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-spark/60";
  const variants = {
    primary:
      "bg-spark text-black hover:bg-spark-200 shadow-[0_0_24px_-6px_rgba(250,204,21,0.7)]",
    secondary:
      "bg-white/5 text-white border border-white/15 hover:bg-white/10",
    ghost: "text-white/70 hover:text-white hover:bg-white/5",
    danger: "bg-red-500/90 text-white hover:bg-red-500",
  } as const;
  const sizes = {
    sm: "h-8 px-3 text-xs",
    md: "h-10 px-4 text-sm",
    lg: "h-12 px-6 text-base",
  } as const;
  return (
    <button
      className={`${base} ${variants[variant]} ${sizes[size]} ${className}`}
      {...props}
    />
  );
}
