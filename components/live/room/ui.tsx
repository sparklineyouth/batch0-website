"use client";
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Loader2 } from "lucide-react";

/**
 * The room's dark surface. Colours are literal values on purpose: the app's
 * light theme remaps utility colours like `bg-black` / `text-white` (see
 * app/globals.css, `.theme-light`), and the call surface must stay dark in both.
 */
export const FOCUS =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FFBB00] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0c0c0e]";

type Variant = "control" | "on" | "primary" | "danger" | "ghost" | "subtle";

const VARIANTS: Record<Variant, string> = {
  // Square control-bar button, idle.
  control: "bg-[#26262b] text-[#f4f4f5] hover:bg-[#323238]",
  // Control that is "on"/active (presenting, panel open).
  on: "bg-[#FFBB00] text-[#141414] hover:bg-[#FFD75C]",
  primary: "bg-[#FFBB00] text-[#141414] hover:bg-[#FFD75C] font-semibold",
  danger: "bg-[#e5484d] text-[#fff] hover:bg-[#ec5d62]",
  ghost: "text-[#d4d4d8] hover:bg-[#26262b] hover:text-[#fff]",
  subtle: "border border-[#34343a] bg-[#18181b] text-[#f4f4f5] hover:bg-[#26262b]",
};

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: "sm" | "md" | "lg" | "icon";
  busy?: boolean;
};

const SIZES = {
  sm: "h-8 px-3 text-xs gap-1.5",
  md: "h-10 px-4 text-sm gap-2",
  lg: "h-12 px-6 text-base gap-2",
  icon: "h-10 w-10 sm:h-11 sm:w-11",
};

export const RoomButton = forwardRef<HTMLButtonElement, Props>(function RoomButton(
  { variant = "subtle", size = "md", busy = false, className = "", children, disabled, type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={`relative inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap rounded-md font-medium leading-none transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS} ${VARIANTS[variant]} ${SIZES[size]} ${className}`}
      {...rest}
    >
      {busy ? <Loader2 className={size === "icon" ? "h-5 w-5 animate-spin" : "h-4 w-4 animate-spin"} aria-hidden /> : null}
      {busy && size === "icon" ? null : children}
    </button>
  );
});

/** Small count bubble for control buttons. */
export function Badge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span className="pointer-events-none absolute -right-1 -top-1 grid h-[18px] min-w-[18px] place-items-center rounded-full bg-[#FFBB00] px-1 text-[10px] font-semibold leading-none text-[#141414]">
      {count > 99 ? "99+" : count}
    </span>
  );
}

export function Spinner({ className = "h-5 w-5" }: { className?: string }) {
  return <Loader2 className={`animate-spin ${className}`} aria-hidden />;
}

/** A centred message on the stage or a terminal screen. */
export function Notice({
  icon,
  title,
  detail,
  children,
  testId,
}: {
  icon?: ReactNode;
  title: ReactNode;
  detail?: ReactNode;
  children?: ReactNode;
  testId?: string;
}) {
  return (
    <div className="mx-auto max-w-md px-6 text-center" data-testid={testId}>
      {icon ? <div className="mb-3 flex justify-center text-[#a1a1aa]">{icon}</div> : null}
      <p className="text-base font-medium text-[#f4f4f5]">{title}</p>
      {detail ? <p className="mt-1.5 text-sm text-[#a1a1aa]">{detail}</p> : null}
      {children ? <div className="mt-5 flex flex-wrap items-center justify-center gap-2">{children}</div> : null}
    </div>
  );
}

export function initials(name: string): string {
  return (
    name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase() ?? "")
      .join("") || "?"
  );
}

/**
 * Form fields on the dark surface. `!` because the light theme restyles every
 * input/select (`.theme-light select { … }` outranks a single utility class).
 */
export const SELECT =
  `h-10 w-full min-w-0 rounded-md border !border-[#34343a] !bg-[#18181b] px-3 text-sm !text-[#f4f4f5] ${FOCUS} disabled:opacity-50`;
