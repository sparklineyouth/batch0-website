"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { changeUserRole } from "./actions";
import type { Role } from "@/lib/types";
import { getActionError } from "@/lib/action-error";

const OPTIONS: Role[] = [
  "student",
  "mentor",
  "investor",
  "admin",
];

const COLORS: Record<Role, string> = {
  student: "border-line text-ink-soft",
  mentor: "border-emerald-500/40 text-emerald-700 dark:text-emerald-300",
  investor: "border-purple-500/40 text-purple-700 dark:text-purple-300",
  admin: "border-spark/50 text-spark-ink",
};

export function RoleSelect({
  userId,
  role,
}: {
  userId: string;
  role: Role;
}) {
  const router = useRouter();
  const [current, setCurrent] = useState<Role>(role);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | undefined>();

  function onChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const next = e.target.value as Role;
    if (next === current) return;
    const previous = current;
    setCurrent(next);
    setError(undefined);
    start(async () => {
      try {
        await changeUserRole(userId, next);
        router.refresh();
      } catch (err: any) {
        setCurrent(previous);
        setError(getActionError(err));
      }
    });
  }

  return (
    <div className="flex flex-col gap-1">
      <select
        value={current}
        disabled={pending}
        onChange={onChange}
        aria-label="Change role"
        className={`appearance-none rounded-full border bg-transparent px-2.5 py-0.5 text-xs font-medium uppercase tracking-wider focus:outline-none focus:ring-1 focus:ring-spark/40 ${COLORS[current]} ${pending ? "opacity-50" : ""}`}
      >
        {OPTIONS.map((r) => (
          <option key={r} value={r} className="bg-paper text-ink">
            {r}
          </option>
        ))}
      </select>
      {error && <span className="text-[10px] text-red-700 dark:text-red-300">{error}</span>}
    </div>
  );
}
