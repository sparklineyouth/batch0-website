"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea, FieldError } from "@/components/ui/input";
import { postTeamMessage } from "@/app/dashboard/team/actions";
import { formatRelativeTime } from "@/lib/format-time";
import { getActionError } from "@/lib/action-error";

type Message = {
  id: string;
  body: string;
  kind: "member" | "mentor" | "investor" | "admin";
  created_at: string;
  author: { full_name: string | null; email: string };
};

const KIND_BADGE: Record<string, string> = {
  member: "bg-white/10 text-white/60",
  mentor: "bg-emerald-400/15 text-emerald-300",
  investor: "bg-spark/15 text-spark",
  admin: "bg-blue-400/15 text-blue-300",
};

/**
 * Team conversation thread, shared between student team view, mentor team
 * detail, and investor team detail. The server-action handles posting
 * authorisation based on the caller's role.
 */
export function TeamThread({
  teamId,
  messages,
}: {
  teamId: string;
  messages: Message[];
}) {
  const router = useRouter();
  const [body, setBody] = useState("");
  const [err, setErr] = useState<string | undefined>();
  const [pending, start] = useTransition();

  function send() {
    setErr(undefined);
    const text = body.trim();
    if (!text) return;
    start(async () => {
      try {
        await postTeamMessage({ teamId, body: text });
        setBody("");
        router.refresh();
      } catch (e: any) {
        setErr(getActionError(e));
      }
    });
  }

  return (
    <Card>
      <h3 className="text-base font-semibold">Conversation</h3>
      <p className="text-xs text-white/50">
        Visible to team members, mentors, investors, and admins.
      </p>

      <ul className="mt-5 space-y-4">
        {messages.length === 0 && (
          <li className="py-6 text-center text-sm text-white/40">
            No messages yet.
          </li>
        )}
        {messages.map((m) => {
          const author = Array.isArray(m.author)
            ? (m.author as any)[0]
            : m.author;
          return (
            <li key={m.id} className="flex gap-3">
              <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-zinc-900 text-xs font-semibold text-white">
                {(author?.full_name ?? author?.email ?? "?")
                  .slice(0, 1)
                  .toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="text-sm font-medium text-white">
                    {author?.full_name ?? author?.email ?? "Someone"}
                  </span>
                  <span
                    className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${
                      KIND_BADGE[m.kind] ?? KIND_BADGE.member
                    }`}
                  >
                    {m.kind}
                  </span>
                  <span className="text-[11px] text-white/40">
                    {formatRelativeTime(m.created_at)}
                  </span>
                </div>
                <p className="mt-1 whitespace-pre-wrap break-words text-sm text-white/85">
                  {m.body}
                </p>
              </div>
            </li>
          );
        })}
      </ul>

      <div className="mt-6 border-t border-white/10 pt-4">
        <Textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Write a message…"
          maxLength={4000}
          rows={3}
        />
        <div className="mt-2 flex items-center justify-between">
          <FieldError>{err}</FieldError>
          <Button
            size="sm"
            onClick={send}
            disabled={pending || !body.trim()}
          >
            {pending ? "Sending…" : "Send"}
          </Button>
        </div>
      </div>
    </Card>
  );
}
