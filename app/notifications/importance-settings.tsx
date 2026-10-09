"use client";
import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RotateCcw } from "lucide-react";
import {
  IMPORTANCE_GROUPS,
  NOTIFICATION_KINDS,
  defaultImportance,
  importanceOf,
  labelForType,
  type Importance,
  type ImportanceOverrides,
  type NotificationKind,
} from "@/lib/notification-importance";
import {
  resetNotificationImportance,
  setNotificationImportance,
} from "./actions";

const OTHER_GROUP = "Everything else";

/**
 * "Which of these matter" — the control behind the two tabs.
 *
 * Classification is per TYPE, not per notification: the point is that a kind
 * of notification you don't care about stops competing for attention from then
 * on, including for the ones that haven't happened yet.
 *
 * `extraTypes` are types present in this person's own notifications that the
 * catalog in lib/notification-importance.ts doesn't name — a feature newer
 * than the list. They're still listed and still reclassifiable; they just
 * render with a humanised label and no hint.
 */
export function ImportanceSettings({
  overrides,
  extraTypes,
}: {
  overrides: ImportanceOverrides;
  extraTypes: string[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  // Local copy so a toggle lands instantly; the server action revalidates and
  // we re-seed from the fresh props when they actually differ.
  const [local, setLocal] = useState<ImportanceOverrides>(overrides);
  const serverKey = JSON.stringify(overrides);
  const lastServerKey = useRef(serverKey);
  useEffect(() => {
    if (lastServerKey.current !== serverKey) {
      lastServerKey.current = serverKey;
      setLocal(overrides);
    }
  }, [serverKey, overrides]);

  const rows: NotificationKind[] = [
    ...NOTIFICATION_KINDS,
    ...extraTypes.map((type) => ({
      type,
      label: labelForType(type),
      group: OTHER_GROUP,
      default: defaultImportance(type),
    })),
  ];

  const groups = [...IMPORTANCE_GROUPS, OTHER_GROUP].filter((g) =>
    rows.some((r) => r.group === g),
  );
  const overrideCount = Object.keys(local).length;

  function choose(type: string, next: Importance) {
    setLocal((prev) => {
      const copy = { ...prev };
      if (next === defaultImportance(type)) delete copy[type];
      else copy[type] = next;
      return copy;
    });
    start(async () => {
      try {
        await setNotificationImportance(type, next);
      } catch {
        // Put the row back the way the server still has it.
        setLocal(overrides);
      }
      router.refresh();
    });
  }

  function resetAll() {
    setLocal({});
    start(async () => {
      try {
        await resetNotificationImportance();
      } catch {
        setLocal(overrides);
      }
      router.refresh();
    });
  }

  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <p className="max-w-xl text-sm text-ink-soft">
          Pick which kinds of notification land in <strong>Important</strong>.
          Everything else still arrives — it just waits for you in the other
          tab.
        </p>
        {overrideCount > 0 && (
          <button
            type="button"
            onClick={resetAll}
            disabled={pending}
            className="press inline-flex shrink-0 items-center gap-1.5 rounded-md border border-line bg-wash px-3 py-1.5 text-xs font-medium text-ink-soft transition hover:border-ink/30 hover:text-ink disabled:opacity-50"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Reset {overrideCount} change{overrideCount === 1 ? "" : "s"}
          </button>
        )}
      </div>

      <div className="mt-8 space-y-9">
        {groups.map((group) => (
          <section key={group}>
            <h3 className="mb-3 font-mono text-[11px] font-semibold uppercase tracking-[0.22em] text-ink-faint">
              {group}
            </h3>
            <ul className="divide-y divide-line border-y border-line">
              {rows
                .filter((r) => r.group === group)
                .map((r) => {
                  const value = importanceOf(r.type, local);
                  const changed = local[r.type] !== undefined;
                  return (
                    <li
                      key={r.type}
                      className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="break-words text-sm text-ink">
                          {r.label}
                          {changed && (
                            <span className="ml-2 align-middle font-mono text-[10px] uppercase tracking-wider text-phosphor-ink">
                              changed
                            </span>
                          )}
                        </p>
                        {r.hint && (
                          <p className="mt-0.5 break-words text-xs text-ink-faint">
                            {r.hint}
                          </p>
                        )}
                      </div>
                      <div
                        role="radiogroup"
                        aria-label={`Importance of “${r.label}”`}
                        className="flex shrink-0 overflow-hidden rounded-md border border-line"
                      >
                        {(
                          [
                            ["important", "Important"],
                            ["other", "Not important"],
                          ] as [Importance, string][]
                        ).map(([v, label]) => (
                          <button
                            key={v}
                            type="button"
                            role="radio"
                            aria-checked={value === v}
                            disabled={pending}
                            onClick={() => choose(r.type, v)}
                            className={`px-3 py-1.5 text-xs font-medium transition disabled:opacity-60 ${
                              value === v
                                ? "bg-phosphor text-on-phosphor"
                                : "bg-paper text-ink-soft hover:bg-wash hover:text-ink"
                            }`}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    </li>
                  );
                })}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
