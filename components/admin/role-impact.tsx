import type { ReactNode } from "react";
import { PERMISSION_BY_KEY } from "@/lib/permissions";
import { PANELS, type AccessDiff } from "@/lib/role-impact";

/**
 * One AccessDiff (lib/role-impact.ts) as a short list of plain sentences: the
 * role editor's "What saving changes", and the email form, the role picker,
 * the bulk change and the delete dialog's "what they'd gain or lose".
 *
 * Every line says gains or loses in words; the + / − / ! in the margin is
 * decoration, so it's hidden from screen readers.
 */

type Tone = "gain" | "loss" | "warn" | "info" | "error";

const TONES: Record<Tone, { mark: string; className: string }> = {
  gain: { mark: "+", className: "text-emerald-700 dark:text-emerald-300" },
  loss: { mark: "−", className: "text-red-700 dark:text-red-300" },
  warn: { mark: "!", className: "text-amber-700 dark:text-amber-300" },
  info: { mark: "→", className: "text-ink-faint" },
  error: { mark: "×", className: "text-red-700 dark:text-red-300" },
};

function Line({ tone, children }: { tone: Tone; children: ReactNode }) {
  const t = TONES[tone];
  return (
    <li className="flex gap-2">
      <span aria-hidden className={`w-3 shrink-0 text-center font-mono font-semibold ${t.className}`}>
        {t.mark}
      </span>
      <span className="min-w-0 text-ink-soft">{children}</span>
    </li>
  );
}

/** "A, B and C", or "A, B, C and 4 more" past `max`. */
function names(items: readonly string[], max = 6): string {
  const shown = items.slice(0, max);
  const rest = items.length - shown.length;
  if (rest > 0) return `${shown.join(", ")} and ${rest} more`;
  if (shown.length <= 1) return shown.join("");
  return `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`;
}

const label = (key: string) => PERMISSION_BY_KEY.get(key)?.label ?? key;
const quoted = (keys: readonly string[]) => keys.map((k) => `“${label(k)}”`);
// A panel key is already its own "Gains the Mentor panel" line.
const PANEL_KEYS = new Set<string>(PANELS.map((p) => p.key));
const notPanel = (key: string) => !PANEL_KEYS.has(key);

export function AccessImpact({
  diff,
  showPermissions = false,
  showNeeds = false,
  emptyText = "No change to what they can open or do.",
}: {
  diff: AccessDiff;
  /** List the permissions gained and lost too (an assignment, where nobody ticked them). */
  showPermissions?: boolean;
  /** List broken PERMISSION_NEEDS pairs (the role editor, where they block a save). */
  showNeeds?: boolean;
  emptyText?: string;
}) {
  const lines: ReactNode[] = [];
  const add = (tone: Tone, content: ReactNode) =>
    lines.push(
      <Line key={lines.length} tone={tone}>
        {content}
      </Line>,
    );

  if (diff.fullAccess === "gains") {
    add(
      "warn",
      <>
        <strong className="font-medium text-ink">Full access</strong>: every permission, now and
        later, including money, everyone&apos;s roles and private conversations.
      </>,
    );
  } else if (diff.fullAccess === "loses") {
    add("loss", "Loses full access.");
  }

  if (diff.adminArea === "gains") {
    const via = diff.adminAreaVia;
    add(
      "gain",
      via.length === 1 ? (
        <>Opens the admin panel: {quoted(via)[0]} on its own is enough.</>
      ) : via.length > 1 ? (
        <>Opens the admin panel, through {names(quoted(via))}.</>
      ) : (
        <>Opens the admin panel.</>
      ),
    );
  } else if (diff.adminArea === "loses") {
    add("loss", "Loses the admin panel.");
  }

  if (diff.pagesGained.length > 0) {
    add("gain", <>Gains admin pages: {names(diff.pagesGained.map((p) => p.label), 8)}.</>);
  }
  if (diff.pagesLost.length > 0) {
    add("loss", <>Loses admin pages: {names(diff.pagesLost.map((p) => p.label), 8)}.</>);
  }
  if (diff.panelsGained.length > 0) {
    add("gain", <>Gains the {names(diff.panelsGained.map((p) => `${p.label} (${p.href})`))}.</>);
  }
  if (diff.panelsLost.length > 0) {
    add("loss", <>Loses the {names(diff.panelsLost.map((p) => `${p.label} (${p.href})`))}.</>);
  }

  // A full-access change already said "every permission"; listing forty of
  // them adds nothing.
  if (showPermissions && diff.fullAccess !== "gains" && diff.fullAccess !== "loses") {
    const gained = diff.gained.filter(notPanel);
    const lost = diff.lost.filter(notPanel);
    if (gained.length > 0) add("gain", <>Can now: {names(gained.map(label))}.</>);
    if (lost.length > 0) add("loss", <>No longer: {names(lost.map(label))}.</>);
  }

  if (diff.fullAccess !== "gains") {
    for (const s of diff.sensitiveGained) {
      add(
        "warn",
        <>
          <strong className="font-medium text-ink">{s.label}</strong> is sensitive: {s.why}.
        </>,
      );
    }
  }

  for (const note of diff.notes) add("info", note);
  if (diff.home && diff.home.before !== diff.home.after) {
    add(
      "info",
      <>
        Lands on <code className="font-mono text-[11px]">{diff.home.after}</code> instead of{" "}
        <code className="font-mono text-[11px]">{diff.home.before}</code>.
      </>,
    );
  }
  if (showNeeds) {
    for (const u of diff.unmet) {
      add("error", <>{quoted([u.key])[0]} needs {quoted([u.needs])[0]} too. Tick both to save.</>);
    }
  }
  for (const i of diff.inert) add("warn", i.reason);
  if (diff.opensNothing) {
    add("warn", "Opens no page: they'd land on a bare /dashboard that says so.");
  }

  if (lines.length === 0) {
    return (
      <p className="text-xs text-ink-faint">
        {diff.same ? emptyText : "No page changes, only what they can do on pages they already open."}
      </p>
    );
  }
  return <ul className="space-y-1.5 text-xs leading-snug">{lines}</ul>;
}
