"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  registerCommands,
  resyncAllRoles,
  refreshLinkedIdentities,
} from "./actions";
import { getActionError } from "@/lib/action-error";

type Status = { kind: "ok" | "error"; text: string } | null;

export function OpsPanel({
  registeredNames,
}: {
  registeredNames: string[] | null;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [status, setStatus] = useState<Status>(null);
  const [names, setNames] = useState<string[] | null>(registeredNames);

  function run(label: string, fn: () => Promise<string>) {
    setStatus(null);
    start(async () => {
      try {
        const msg = await fn();
        setStatus({ kind: "ok", text: msg });
        router.refresh();
      } catch (e) {
        setStatus({ kind: "error", text: getActionError(e) });
      }
    });
  }

  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-3">
        <Button
          type="button"
          variant="secondary"
          disabled={pending}
          onClick={() =>
            run("register", async () => {
              const { names } = await registerCommands();
              setNames(names);
              return `Registered ${names.length} command${names.length === 1 ? "" : "s"}.`;
            })
          }
        >
          Register slash commands
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={pending}
          onClick={() =>
            run("resync", async () => {
              const { attempted, succeeded } = await resyncAllRoles();
              return `Re-synced ${succeeded}/${attempted} member${attempted === 1 ? "" : "s"}.`;
            })
          }
        >
          Re-sync all roles
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={pending}
          onClick={() =>
            run("refresh", async () => {
              const { attempted, succeeded } = await refreshLinkedIdentities();
              return `Refreshed ${succeeded}/${attempted} profile${attempted === 1 ? "" : "s"}.`;
            })
          }
        >
          Refresh usernames + avatars
        </Button>
      </div>

      {status && (
        <p
          className={
            status.kind === "ok"
              ? "text-xs text-emerald-700 dark:text-emerald-300"
              : "text-xs text-red-700 dark:text-red-300"
          }
        >
          {status.text}
        </p>
      )}

      <div>
        <p className="text-xs uppercase tracking-wider text-ink-faint">
          Currently registered with Discord
        </p>
        {names === null ? (
          <p className="mt-2 text-xs text-ink-faint">
            Couldn't reach Discord — check the bot token.
          </p>
        ) : names.length === 0 ? (
          <p className="mt-2 text-xs text-amber-700 dark:text-amber-200">
            No commands registered yet. Click <strong>Register slash commands</strong> above.
          </p>
        ) : (
          <ul className="mt-2 flex flex-wrap gap-1.5">
            {names.map((n) => (
              <li
                key={n}
                className="rounded-full border border-line bg-wash px-2 py-0.5 text-[11px] text-spark-ink"
              >
                /{n}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
