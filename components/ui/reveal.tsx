"use client";
import { useEffect, useRef } from "react";

/**
 * IntersectionObserver-based reveal. Drop-in replacement for the
 * framer-motion `whileInView` pattern we used everywhere on marketing,
 * minus the ~50KB of motion runtime. The element starts hidden via
 * `.reveal` (see globals.css) and gets `.revealed` once it crosses the
 * viewport — once and only once.
 *
 * Use sparingly: above-the-fold sections should just use the CSS
 * `animate-fade-up` keyframe + an inline `animation-delay`, no observer
 * needed.
 */
export function Reveal({
  as: Tag = "div",
  className = "",
  delay = 0,
  children,
  ...rest
}: {
  as?: any;
  className?: string;
  delay?: number;
  children: React.ReactNode;
  [k: string]: any;
}) {
  const ref = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      el.classList.add("revealed");
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            (e.target as HTMLElement).classList.add("revealed");
            io.unobserve(e.target);
          }
        }
      },
      { rootMargin: "0px 0px -10% 0px", threshold: 0.01 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const style = delay ? { transitionDelay: `${delay}ms` } : undefined;
  return (
    <Tag ref={ref as any} className={`reveal ${className}`} style={style} {...rest}>
      {children}
    </Tag>
  );
}
