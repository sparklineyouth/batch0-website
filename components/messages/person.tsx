import { ShieldCheck } from "lucide-react";
import type { DmPerson } from "@/lib/dm";

/**
 * Bits of person-rendering shared by the inbox, the popup, and the directory
 * search, so a name looks the same in all three. Server-safe (no hooks): the
 * full page renders these directly.
 */

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * A deterministic tint per person, so the same face is the same colour
 * everywhere without storing anything. Hue only — lightness and saturation
 * are fixed so every avatar keeps the same contrast against both themes.
 */
function hue(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return h;
}

export function Avatar({
  person,
  size = "md",
}: {
  person: Pick<DmPerson, "id" | "name">;
  size?: "sm" | "md" | "lg";
}) {
  const box =
    size === "sm" ? "h-7 w-7 text-[10px]" : size === "lg" ? "h-11 w-11 text-sm" : "h-9 w-9 text-xs";
  const h = hue(person.id);
  return (
    <span
      aria-hidden
      style={{
        backgroundColor: `hsl(${h} 45% 88%)`,
        color: `hsl(${h} 55% 28%)`,
        borderColor: `hsl(${h} 40% 78%)`,
      }}
      className={`${box} inline-flex shrink-0 items-center justify-center rounded-full border font-mono font-semibold leading-none`}
    >
      {initials(person.name)}
    </span>
  );
}

/** Name plus, when there is one, the role they hold. */
export function PersonLabel({
  person,
  className = "",
}: {
  person: DmPerson;
  className?: string;
}) {
  return (
    <span className={`inline-flex min-w-0 max-w-full items-center gap-1.5 ${className}`}>
      <span className="truncate font-medium text-ink">{person.name}</span>
      {person.isStaff ? (
        <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-phosphor/15 px-1.5 py-px text-[10px] font-medium text-phosphor-ink">
          <ShieldCheck className="h-2.5 w-2.5" />
          {person.roleLabel ?? "Team"}
        </span>
      ) : (
        person.roleLabel && (
          <span className="shrink-0 rounded-full border border-line px-1.5 py-px text-[10px] text-ink-faint">
            {person.roleLabel}
          </span>
        )
      )}
    </span>
  );
}
