"use client";
import type { ChatPerson } from "@/lib/chat";

/**
 * The chat preview's stand-in for the thread pane's reads (0110): GET
 * /chat/api/thread, /unanswered and /members answer from fixtures, so the
 * pane can be looked at with no database. Dev only — app/dev/chat 404s in
 * production — and it patches nothing but those three paths.
 */
export function PreviewFetch(props: {
  channelId: string;
  rootId: string;
  people: Record<string, ChatPerson>;
  me: string;
  maya: string;
  sam: string;
  rish: string;
  dev: string;
}) {
  if (typeof window !== "undefined" && !(window as any).__chatPreviewFetch) {
    (window as any).__chatPreviewFetch = true;
    const real = window.fetch.bind(window);
    const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
    const msg = (id: string, senderId: string, body: string, min: number, extra: object = {}) => ({
      id,
      channelId: props.channelId,
      senderId,
      body,
      kind: "message",
      replyTo: null,
      mentions: [],
      mentionEveryone: false,
      attachments: [],
      reactions: {},
      createdAt: ago(min),
      editedAt: null,
      pinnedAt: null,
      threadRootId: props.rootId,
      ...extra,
    });
    const root = {
      ...msg(props.rootId, props.maya, "How should I recruit my first five interviewees? Nobody at school has replied to my form.", 90),
      threadRootId: undefined,
      thread: { replyCount: 4, lastReplyAt: ago(8), question: "open", answerId: null },
    };
    const replies = [
      msg("r1", props.dev, "Ask your teachers which clubs have the people you want to talk to.", 70),
      msg("r2", props.sam, "Don't use a form. Message five people directly, one line each: who you are, 15 minutes, a time.", 40, {
        reactions: { "👍": [props.maya, props.dev] },
      }),
      msg("r3", props.maya, "ok trying that tonight", 30),
      msg("r4", props.rish, "Week 2's lesson has a script for the first message. Start there.", 8),
    ];
    const json = (data: unknown) =>
      new Response(JSON.stringify({ ok: true, data }), { status: 200, headers: { "content-type": "application/json" } });
    window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, window.location.href);
      if (url.pathname === "/chat/api/thread") {
        return Promise.resolve(
          json({
            info: {
              rootId: props.rootId,
              channelId: props.channelId,
              questionChannel: true,
              question: "open",
              answerId: null,
              canDecide: false,
              following: true,
              help: { status: "open", owner: "Rish", reference: null, href: null, yours: false },
              about: { kind: "lesson", id: "l0000000-0000-4000-8000-000000000001", title: "Week 2 · Customer interviews", href: "/dashboard/course/l0000000-0000-4000-8000-000000000001" },
            },
            root,
            replies,
            hasMoreBefore: false,
            people: props.people,
            asOf: ago(0),
          }),
        );
      }
      if (url.pathname === "/chat/api/unanswered") {
        return Promise.resolve(json({ questions: [root], total: 1, people: props.people }));
      }
      if (url.pathname === "/chat/api/members") return Promise.resolve(json(Object.values(props.people)));
      return real(input, init);
    };
  }
  return null;
}
