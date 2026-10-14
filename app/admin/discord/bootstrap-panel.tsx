"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { bootstrapDiscordServer } from "./actions";
import { getActionError } from "@/lib/action-error";
import type { BootstrapResult } from "@/lib/discord";

const CONFIRM_PHRASE = "DELETE AND REBUILD";

export function BootstrapPanel() {
  const router = useRouter();
  const [confirm, setConfirm] = useState("");
  const [armed, setArmed] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | undefined>();
  const [result, setResult] = useState<BootstrapResult | undefined>();

  const canRun = confirm === CONFIRM_PHRASE && armed;

  function run() {
    setError(undefined);
    setResult(undefined);
    start(async () => {
      try {
        const r = await bootstrapDiscordServer(confirm);
        setResult(r);
        setConfirm("");
        setArmed(false);
        router.refresh();
      } catch (e) {
        setError(getActionError(e));
      }
    });
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-red-500/30 bg-red-500/[0.06] p-4">
        <p className="text-sm font-semibold text-red-700 dark:text-red-200">
          Every channel (with its message history) and every custom role is deleted.
        </p>
        <p className="mt-1 text-xs text-red-700/80 dark:text-red-100/80">
          The bot needs Manage Channels and Manage Roles, with its role above @everyone.
        </p>
      </div>

      <div>
        <Label>
          Type{" "}
          <code className="rounded bg-wash px-1 py-0.5 text-phosphor-ink">
            {CONFIRM_PHRASE}
          </code>{" "}
          to enable the button
        </Label>
        <Input
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          placeholder={CONFIRM_PHRASE}
          autoComplete="off"
          spellCheck={false}
        />
      </div>

      <label className="flex items-center gap-2 text-xs text-ink-soft">
        <input
          type="checkbox"
          checked={armed}
          onChange={(e) => setArmed(e.target.checked)}
        />
        I understand this is irreversible.
      </label>

      <div className="flex items-center gap-3">
        <Button
          type="button"
          variant="secondary"
          disabled={!canRun || pending}
          onClick={run}
          className="!bg-red-500/15 !text-red-700 dark:!text-red-100 hover:!bg-red-500/25 disabled:!opacity-40"
        >
          {pending ? "Rebuilding… (10–30s)" : "Wipe and rebuild server"}
        </Button>
        {pending && (
          <span className="text-xs text-ink-soft">
            Don&apos;t navigate away.
          </span>
        )}
      </div>

      {error && (
        <p className="rounded-lg border border-red-500/30 bg-red-500/[0.08] p-3 text-xs text-red-700 dark:text-red-200">
          {error}
        </p>
      )}

      {result && (
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/[0.06] p-4 text-xs text-emerald-700/90 dark:text-emerald-100/90">
          <p className="font-semibold text-emerald-700 dark:text-emerald-200">
            ✅ Server rebuilt successfully.
          </p>
          <ul className="mt-2 space-y-1">
            <li>
              Deleted {result.channelsDeleted} channel
              {result.channelsDeleted === 1 ? "" : "s"} and {result.rolesDeleted}{" "}
              role{result.rolesDeleted === 1 ? "" : "s"}.
            </li>
            <li>
              Created {result.rolesCreated.length} roles:{" "}
              {result.rolesCreated.map((r) => r.name).join(", ")}.
            </li>
            <li>
              Created {result.channelsCreated.length} channels.
            </li>
            <li>
              Channel + role IDs saved to site_settings — ping the channels above
              to confirm.
            </li>
          </ul>
        </div>
      )}
    </div>
  );
}
