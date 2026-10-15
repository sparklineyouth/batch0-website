"use client";
import { initials } from "@/lib/chat-view";
import { roleColorClasses } from "@/lib/permissions";
import type { ChatPerson } from "@/lib/chat";

/**
 * A person's square: initials on the quiet wash, a 1px line, and — when
 * they're online — a phosphor dot. One accent, per DESIGN.md: presence is the
 * "live" meta the yellow already means everywhere else.
 */
export function Avatar({
  name,
  online = false,
  size = 36,
  className = "",
}: {
  name: string;
  online?: boolean;
  size?: number;
  className?: string;
}) {
  const text = initials(name);
  return (
    <span
      aria-hidden
      className={`relative inline-flex shrink-0 select-none items-center justify-center rounded-md border border-line bg-wash font-mono font-semibold text-ink-soft ${className}`}
      style={{ width: size, height: size, fontSize: Math.max(10, Math.round(size * 0.36)) }}
    >
      {text}
      {online ? (
        <span
          className="absolute -bottom-0.5 -right-0.5 rounded-full border-2 border-paper bg-phosphor"
          style={{ width: Math.max(8, size * 0.3), height: Math.max(8, size * 0.3) }}
        />
      ) : null}
    </span>
  );
}

/** A role badge next to a name: "Mentor", "Admin", a custom role in its colour. */
export function RoleTag({ person }: { person: Pick<ChatPerson, "roleLabel" | "roleColor"> | null | undefined }) {
  if (!person?.roleLabel) return null;
  return (
    <span
      className={`inline-flex items-center rounded border px-1 py-px font-mono text-[10px] font-medium leading-none ${roleColorClasses(person.roleColor)}`}
    >
      {person.roleLabel}
    </span>
  );
}
