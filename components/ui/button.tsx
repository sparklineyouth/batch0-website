import * as React from "react";
import Link from "next/link";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md" | "lg";

type Props = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: Size;
};

// Instant feedback: no easing on hover/active so the click "snaps".
// Only the press scale animates, and via transform alone so it stays
// composited on the GPU.
// `whitespace-nowrap` keeps short labels like "Re-score" or "Waive & enroll"
// on a single line when the button sits inside a narrow flex column —
// without it the hyphen / ampersand becomes a soft wrap point.
const BASE =
  "inline-flex select-none items-center justify-center gap-2 whitespace-nowrap rounded-md font-semibold leading-none active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-phosphor focus-visible:ring-offset-2 focus-visible:ring-offset-paper";

const VARIANTS = {
  primary: "bg-phosphor text-on-phosphor shadow-cta hover:bg-phosphor-200",
  secondary:
    "bg-paper text-ink border border-line hover:border-ink/30 hover:bg-wash",
  ghost: "text-ink-soft hover:text-ink hover:bg-wash",
  // `text-[#fff]`, not `text-white`. The light-theme compatibility layer maps
  // `.theme-light .text-white` to #141414 (app/globals.css:706) so that dark-
  // mode-authored surfaces stay readable on paper — but it has no matching
  // override for a SOLID `bg-red-500`, which stays red in both themes. The two
  // together painted near-black text on red across all 13 danger buttons in
  // light mode. The arbitrary-value class sidesteps the override by name.
  danger: "bg-red-500 text-[#fff] hover:bg-red-600",
} as const;

const SIZES = {
  sm: "h-8 px-3 text-xs",
  md: "h-10 px-4 text-sm",
  lg: "h-12 px-6 text-base",
} as const;

/** The shared class string, so an anchor can look exactly like a button. */
export function buttonClasses(
  variant: Variant = "primary",
  size: Size = "md",
  className = "",
) {
  return `${BASE} ${VARIANTS[variant]} ${SIZES[size]} ${className}`;
}

export const Button = React.forwardRef<HTMLButtonElement, Props>(function Button(
  { className = "", variant = "primary", size = "md", type = "button", ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      // Explicit default. A bare <button> is type="submit", so any Button
      // dropped inside a form silently submits it. Every form-submit Button in
      // the codebase already says type="submit" outright (17 of them; zero
      // rely on the implicit default), so this only closes the trap.
      type={type}
      className={buttonClasses(variant, size, className)}
      {...props}
    />
  );
});

/**
 * A link that looks like a button.
 *
 * Replaces `<Link><Button>…</Button></Link>`, which renders `<a><button>` —
 * interactive content nested inside an anchor. That is invalid HTML, and it
 * costs the user two tab stops with two differently-shaped focus rings (the
 * anchor gets the UA default, the button gets the phosphor ring) plus a
 * screen-reader announcement of the same label twice under conflicting roles.
 *
 * Note there is no `disabled` — it does nothing on an anchor. A call site that
 * needs a disabled state wants a real <Button>, or `aria-disabled` plus its
 * own styling.
 */
export const ButtonLink = React.forwardRef<
  HTMLAnchorElement,
  React.ComponentPropsWithoutRef<typeof Link> & {
    variant?: Variant;
    size?: Size;
  }
>(function ButtonLink(
  { className = "", variant = "primary", size = "md", ...props },
  ref,
) {
  return (
    <Link ref={ref} className={buttonClasses(variant, size, className)} {...props} />
  );
});
