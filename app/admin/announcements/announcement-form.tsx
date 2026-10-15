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
import { MUTED_REASON } from "@/lib/chat-access";
import { Toggle } from "@/components/ui/toggle";
import { broadcastAnnouncement } from "./actions";

type Cohort = { id: string; name: string };

export function AnnouncementForm({ cohorts }: { cohorts: Cohort[] }) {
  const [cohortId, setCohortId] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [emailToo, setEmailToo] = useState(true);
  const [chatToo, setChatToo] = useState(true);
  const [pingEveryone, setPingEveryone] = useState(false);
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
          postChat: chatToo,
          mentionEveryone: chatToo && pingEveryone,
        });
        setResult(
          `Sent to ${out.recipients} student${out.recipients === 1 ? "" : "s"}` +
            (out.chatPosted ? (cohortId ? " and posted in the cohort's channel." : " and posted in #announcements.") : "."),
        );
        if (chatToo && !out.chatPosted) {
          // A chat mute holds here too (lib/chat-post.ts): then posting it
          // yourself isn't the way round it.
          setError(
            `The chat post didn't go through${
              out.chatError ? ` (${out.chatError})` : ""
            }.${out.chatError === MUTED_REASON ? "" : " You can post it in Chat yourself."}`,
          );
        }
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
        label={cohortId ? "Also post in the cohort's channel" : "Also post in #announcements"}
        description={
          cohortId
            ? "Post it in this cohort's channel in Chat, where only the cohort, the mentors assigned to its students, and staff read it."
            : "Post it in the #announcements channel in Chat, where everyone at batch0 can read it."
        }
        checked={chatToo}
        onChange={setChatToo}
      />
      {chatToo && (
        <Toggle
          label="Notify everyone (@everyone)"
          description="Sends a notification to everyone who can read the channel. Leave off for routine updates."
          checked={pingEveryone}
          onChange={setPingEveryone}
        />
      )}
      {result && (
        <p className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-200">
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
