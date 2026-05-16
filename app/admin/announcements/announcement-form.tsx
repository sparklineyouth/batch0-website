"use client";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import {
  Input,
  Textarea,
  Label,
  Select,
  FieldError,
} from "@/components/ui/input";
import { getActionError } from "@/lib/action-error";
import { Toggle } from "@/components/ui/toggle";
import { broadcastAnnouncement, type AnnouncementPing } from "./actions";

type Cohort = { id: string; name: string };
type PingableRole = { role: "student" | "mentor" | "admin" | "investor"; label: string };

export function AnnouncementForm({
  cohorts,
  pingableRoles,
}: {
  cohorts: Cohort[];
  pingableRoles: PingableRole[];
}) {
  const [cohortId, setCohortId] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [emailToo, setEmailToo] = useState(true);
  const [discordToo, setDiscordToo] = useState(true);
  const [discordPing, setDiscordPing] = useState<AnnouncementPing>("none");
  const [pending, start] = useTransition();
  const [result, setResult] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();

  function send() {
    setError(undefined);
    setResult(undefined);
    start(async () => {
      try {
        const out = await broadcastAnnouncement({
          cohortId: cohortId || null,
          title,
          body,
          sendEmail: emailToo,
          postDiscord: discordToo,
          discordPing: discordToo ? discordPing : "none",
        });
        setResult(
          `Sent to ${out.recipients} student${out.recipients === 1 ? "" : "s"}` +
            (out.discordPosted ? " and posted to Discord." : "."),
        );
        setTitle("");
        setBody("");
      } catch (e: any) {
        setError(getActionError(e));
      }
    });
  }

  return (
    <div className="space-y-4">
      <div>
        <Label>Audience</Label>
        <Select value={cohortId} onChange={(e) => setCohortId(e.target.value)}>
          <option value="">All enrolled students</option>
          {cohorts.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
      </div>
      <div>
        <Label>Title</Label>
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Demo Day moved to Friday"
        />
      </div>
      <div>
        <Label>Message</Label>
        <Textarea
          rows={5}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Hey team — quick update…"
        />
      </div>
      <Toggle
        label="Send email"
        description="Email this announcement to every recipient."
        checked={emailToo}
        onChange={setEmailToo}
      />
      <Toggle
        label="Post to Discord"
        description="Cross-post to your Discord announcements channel."
        checked={discordToo}
        onChange={setDiscordToo}
      />
      {discordToo && (
        <div className="rounded-xl border border-white/10 bg-black/30 px-4 py-3.5">
          <Label>Discord ping</Label>
          <Select
            value={discordPing}
            onChange={(e) =>
              setDiscordPing(e.target.value as AnnouncementPing)
            }
          >
            <option value="none">No ping (silent post)</option>
            <option value="everyone">@everyone (push to everyone)</option>
            <option value="here">@here (only currently online)</option>
            {pingableRoles.map((r) => (
              <option key={r.role} value={r.role}>
                Ping {r.label} role
              </option>
            ))}
          </Select>
          <p className="mt-1.5 text-xs text-white/50">
            Use @everyone sparingly — it notifies everyone in the server,
            including unrelated members. Role pings only configure if the
            role ID is set under Admin → Discord.
          </p>
        </div>
      )}
      {result && (
        <p className="rounded-lg border border-emerald-400/30 bg-emerald-400/5 px-3 py-2 text-xs text-emerald-200">
          {result}
        </p>
      )}
      <FieldError>{error}</FieldError>
      <div>
        <Button onClick={send} disabled={pending || !title.trim() || !body.trim()}>
          {pending ? "Sending…" : "Send announcement"}
        </Button>
      </div>
    </div>
  );
}
