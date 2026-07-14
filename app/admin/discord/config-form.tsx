"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input, Label, FieldError } from "@/components/ui/input";
import { saveDiscordConfig, pingChannel, type DiscordConfigInput } from "./actions";
import { getActionError } from "@/lib/action-error";

export function DiscordConfigForm({
  initial,
}: {
  initial: DiscordConfigInput;
}) {
  const router = useRouter();
  const [values, setValues] = useState(initial);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | undefined>();
  const [okMsg, setOkMsg] = useState<string | undefined>();

  function set<K extends keyof DiscordConfigInput>(k: K, v: string) {
    setValues((p) => ({ ...p, [k]: v }));
  }

  function save() {
    setError(undefined);
    setOkMsg(undefined);
    start(async () => {
      try {
        await saveDiscordConfig(values);
        setOkMsg("Discord config saved.");
        router.refresh();
      } catch (e: any) {
        setError(getActionError(e));
      }
    });
  }

  function ping(which: "announcements" | "events" | "admin_feed") {
    setError(undefined);
    setOkMsg(undefined);
    start(async () => {
      try {
        await pingChannel(which);
        setOkMsg(`Sent a test message to #${which}.`);
      } catch (e: any) {
        setError(getActionError(e));
      }
    });
  }

  return (
    <div className="space-y-8">
      <Section
        title="Channels"
        hint="Snowflake IDs (right-click a channel in Discord → Copy ID; needs Developer Mode on)."
      >
        <Row
          label="Announcements channel ID"
          value={values.announcementsChannelId}
          onChange={(v) => set("announcementsChannelId", v)}
          onPing={() => ping("announcements")}
          pingDisabled={!values.announcementsChannelId || pending}
        />
        <Row
          label="Events channel ID"
          value={values.eventsChannelId}
          onChange={(v) => set("eventsChannelId", v)}
          onPing={() => ping("events")}
          pingDisabled={!values.eventsChannelId || pending}
        />
        <Row
          label="Admin feed channel ID"
          hint="Where applications, payments and refunds show up. Optional."
          value={values.adminFeedChannelId}
          onChange={(v) => set("adminFeedChannelId", v)}
          onPing={() => ping("admin_feed")}
          pingDisabled={!values.adminFeedChannelId || pending}
        />
      </Section>

      <Section
        title="Feature pack channels"
        hint="Optional. Each feature silently no-ops when its channel ID is blank."
      >
        <Row
          label="Teams category ID"
          hint="Auto-created team channels land here. Use a category, not a regular channel."
          value={values.teamsCategoryId}
          onChange={(v) => set("teamsCategoryId", v)}
        />
        <Row
          label="#wins channel ID"
          hint="Milestone check-ins cross-post here."
          value={values.winsChannelId}
          onChange={(v) => set("winsChannelId", v)}
        />
        <Row
          label="#help channel ID"
          hint="The 'Mentors on-call now' pin lives here."
          value={values.helpChannelId}
          onChange={(v) => set("helpChannelId", v)}
        />
        <Row
          label="Office hours voice channel ID"
          hint="Where mentors take queue calls. Must be a voice channel."
          value={values.ohVoiceChannelId}
          onChange={(v) => set("ohVoiceChannelId", v)}
        />
        <Row
          label="#introductions channel ID"
          hint="The onboarding DM points here for step 2."
          value={values.introductionsChannelId}
          onChange={(v) => set("introductionsChannelId", v)}
        />
      </Section>

      <Section
        title="Role IDs"
        hint="A role ID for each batch0 role. We auto-assign these on link, on role change, and on enrollment."
      >
        <Row
          label="Student role ID"
          value={values.roleStudentId}
          onChange={(v) => set("roleStudentId", v)}
        />
        <Row
          label="Mentor role ID"
          value={values.roleMentorId}
          onChange={(v) => set("roleMentorId", v)}
        />
        <Row
          label="Admin role ID"
          value={values.roleAdminId}
          onChange={(v) => set("roleAdminId", v)}
        />
        <Row
          label="Investor role ID"
          value={values.roleInvestorId}
          onChange={(v) => set("roleInvestorId", v)}
        />
      </Section>

      {error && <FieldError>{error}</FieldError>}
      {okMsg && <p className="text-xs text-emerald-700 dark:text-emerald-300">{okMsg}</p>}

      <div className="flex justify-end">
        <Button onClick={save} disabled={pending}>
          {pending ? "Saving…" : "Save Discord config"}
        </Button>
      </div>
    </div>
  );
}

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <h3 className="text-sm font-semibold uppercase tracking-wider text-ink-soft">
        {title}
      </h3>
      {hint && <p className="mt-1 text-xs text-ink-faint">{hint}</p>}
      <div className="mt-4 space-y-4">{children}</div>
    </div>
  );
}

function Row({
  label,
  hint,
  value,
  onChange,
  onPing,
  pingDisabled,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
  onPing?: () => void;
  pingDisabled?: boolean;
}) {
  return (
    <div>
      <Label>{label}</Label>
      <div className="flex items-center gap-2">
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="e.g. 123456789012345678"
          inputMode="numeric"
        />
        {onPing && (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={onPing}
            disabled={pingDisabled}
          >
            Ping
          </Button>
        )}
      </div>
      {hint && <p className="mt-1 text-xs text-ink-faint">{hint}</p>}
    </div>
  );
}
