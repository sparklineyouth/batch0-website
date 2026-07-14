"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea, FieldError } from "@/components/ui/input";
import { postTeamMessage } from "./actions";
import { formatRelativeTime } from "@/lib/format-time";
import { getActionError } from "@/lib/action-error";

type Message = {
  id: string;
  body: string;
  kind: "member" | "mentor" | "investor" | "admin";
  created_at: string;
  author: { full_name: string | null; email: string; role: string };
};

const KIND_BADGE: Record<string, string> = {
  member: "bg-wash text-ink-soft",
  mentor: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  investor: "bg-phosphor/15 text-phosphor-ink",
  admin: "bg-blue-500/10 text-blue-700 dark:text-blue-300",
};

export function TeamThreadTab({
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
      <h3 className="text-base font-semibold">Thread</h3>
      <p className="text-xs text-ink-faint">
        Anyone on the team plus mentors and investors can post here.
      </p>

      <ul className="mt-5 space-y-4">
        {messages.length === 0 && (
          <li className="py-6 text-center text-sm text-ink-faint">
            No messages yet. Be the first to post.
          </li>
        )}
        {messages.map((m) => {
          const author = Array.isArray(m.author) ? (m.author as any)[0] : m.author;
          return (
            <li key={m.id} className="flex gap-3">
              <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-wash text-xs font-semibold text-ink">
                {(author?.full_name ?? author?.email ?? "?")
                  .slice(0, 1)
                  .toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="text-sm font-medium text-ink">
                    {author?.full_name ?? author?.email ?? "Someone"}
                  </span>
                  <span
                    className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${
                      KIND_BADGE[m.kind] ?? KIND_BADGE.member
                    }`}
                  >
                    {m.kind}
                  </span>
                  <span className="text-[11px] text-ink-faint">
                    {formatRelativeTime(m.created_at)}
                  </span>
                </div>
                <p className="mt-1 whitespace-pre-wrap text-sm text-ink-soft break-words">
                  {m.body}
                </p>
              </div>
            </li>
          );
        })}
      </ul>

      <div className="mt-6 border-t border-line pt-4">
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
