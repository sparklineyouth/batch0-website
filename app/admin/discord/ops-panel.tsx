"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  registerCommands,
  resyncAllRoles,
  refreshLinkedIdentities,
  repairDiscordServer,
  fixInteractionsEndpoint,
} from "./actions";
import { getActionError } from "@/lib/action-error";

type Status = { kind: "ok" | "error"; text: string } | null;

export function OpsPanel() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [status, setStatus] = useState<Status>(null);

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
      <div className="grid gap-3 xl:grid-cols-3">
        <Button
          type="button"
          variant="secondary"
          disabled={pending}
          onClick={() =>
            run("register", async () => {
              const { names } = await registerCommands();
              return `Registered ${names.length} command${names.length === 1 ? "" : "s"}: /${names.join(", /")}.`;
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

      {/*
        The two repairs for the failures that look like configuration
        problems but can't be fixed from the config form below: IDs that
        dangle because the channel or role was deleted in Discord, and an
        interactions endpoint left pointing at an old domain.
      */}
      <div className="grid gap-3 lg:grid-cols-2">
        <Button
          type="button"
          variant="secondary"
          disabled={pending}
          onClick={() =>
            run("repair", async () => {
              const r = await repairDiscordServer();
              const made =
                r.rolesCreated.length + r.channelsCreated.length;
              const kept = r.rolesReused.length + r.channelsReused.length;
              return made === 0
                ? `Nothing missing — re-pointed config at ${kept} existing channel/role${kept === 1 ? "" : "s"}.`
                : `Recreated ${made} missing item${made === 1 ? "" : "s"} (${[
                    ...r.rolesCreated.map((x) => x.name),
                    ...r.channelsCreated.map((x) => `#${x.name}`),
                  ].join(", ")}); kept ${kept} existing.`;
            })
          }
        >
          Repair server layout
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={pending}
          onClick={() =>
            run("endpoint", async () => {
              const { url } = await fixInteractionsEndpoint();
              return `Discord will now deliver interactions to ${url}.`;
            })
          }
        >
          Point interactions endpoint here
        </Button>
      </div>
      <p className="text-xs text-ink-faint">
        Repair recreates missing channels and roles; it never deletes.
      </p>

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
    </div>
  );
}
