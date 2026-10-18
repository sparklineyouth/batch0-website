import { notFound } from "next/navigation";
import { ChatApp } from "@/components/chat/chat-app";
import type { ChatPerson, SidebarData, SidebarItem } from "@/lib/chat";
import type { ThreadSummary } from "@/lib/chat-threads-rules";
import type { ChannelPayload } from "@/lib/chat-payload";
import { PreviewFetch } from "./preview-fetch";

/**
 * Interface preview for batch0 Chat against fixtures — no auth, no database.
 * Gated like app/dev/apply: renders on localhost and branch previews, 404s on
 * production (VERCEL_ENV, not NODE_ENV).
 *
 *   ?view=channel|dm|readonly|draft|empty|help|thread|ask   which pane to open
 *
 * `help` is #help with questions and threads (0110); `thread` opens one of
 * them in the side pane; `ask` is #help opened from a lesson's "Ask about
 * this", the lesson linked in the composer. The thread pane's reads are answered from fixtures
 * (preview-fetch.tsx). Actions still run (and fail without a database, which
 * is fine for looking at the layout); realtime simply never connects.
 */
export const metadata = { title: "Chat preview · batch0", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

const ME = "11111111-1111-4111-8111-111111111111";
const MAYA = "22222222-2222-4222-8222-222222222222";
const DEV = "33333333-3333-4333-8333-333333333333";
const RISH = "44444444-4444-4444-8444-444444444444";
const SAM = "55555555-5555-4555-8555-555555555555";

const people: Record<string, ChatPerson> = {
  [ME]: { id: ME, name: "Ava Patel", roleLabel: null, roleColor: null, isStaff: false, isStudent: true },
  [MAYA]: { id: MAYA, name: "Maya Chen", roleLabel: null, roleColor: null, isStaff: false, isStudent: true },
  [DEV]: { id: DEV, name: "Dev Okafor", roleLabel: null, roleColor: null, isStaff: false, isStudent: true },
  [RISH]: { id: RISH, name: "Rish", roleLabel: "Admin", roleColor: "phosphor", isStaff: true, isStudent: false },
  [SAM]: { id: SAM, name: "Sam Rivera", roleLabel: "Mentor", roleColor: "emerald", isStaff: false, isStudent: false },
};

function item(over: Partial<SidebarItem> & Pick<SidebarItem, "id" | "label">): SidebarItem {
  return {
    kind: "channel",
    topic: null,
    audience: "everyone",
    posting: "everyone",
    systemKey: null,
    teamId: null,
    cohortId: null,
    otherId: null,
    memberIds: [],
    lastMessageAt: null,
    preview: null,
    unread: 0,
    mentions: 0,
    notify: null,
    position: 0,
    ...over,
  };
}

const C = (n: number) => `c0000000-0000-4000-8000-00000000000${n}`;
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

const sidebar: SidebarData = {
  channels: [
    item({ id: C(1), label: "announcements", posting: "staff", systemKey: "announcements", unread: 1, mentions: 1 }),
    item({ id: C(2), label: "general", systemKey: "general", topic: "Say hi. Talk shop with everyone at batch0.", unread: 4 }),
    item({ id: C(3), label: "wins", systemKey: "wins" }),
    item({ id: C(4), label: "help", systemKey: "help" }),
    item({ id: C(5), label: "fall-2026", audience: "cohort", position: 10, unread: 2, mentions: 1 }),
    item({ id: C(6), label: "team-lumen", audience: "team", position: 20 }),
  ],
  conversations: [
    item({ id: C(7), kind: "dm", audience: "members", label: "Maya Chen", otherId: MAYA, preview: "ok shipping the landing page tonight 🚀", unread: 2, mentions: 2, lastMessageAt: ago(3) }),
    item({ id: C(8), kind: "group", audience: "members", label: "Lumen founders", memberIds: [ME, MAYA, DEV], preview: "Dev: can someone review the deck?", lastMessageAt: ago(40) }),
    item({ id: C(9), kind: "dm", audience: "members", label: "Rish", otherId: RISH, preview: "You: thanks!", lastMessageAt: ago(300) }),
  ],
  people,
  blocked: [],
};

const msgs = [
  { id: "m1", senderId: RISH, body: "**Welcome to #general** 👋 Intros below: name, school, what you're building.", min: 180, reactions: { "👋": [MAYA, DEV, ME], "🔥": [MAYA] } },
  { id: "m2", senderId: MAYA, body: "Maya, Westfield HS. Building **Lumen**: a study-group finder for AP classes.\nWe have 40 people on the waitlist already.", min: 170 },
  { id: "m3", senderId: MAYA, body: "Landing page: https://lumen.example.com", min: 169 },
  { id: "m4", senderId: DEV, body: "Dev here, on Lumen with Maya. Ask me anything about the `supabase` setup.", min: 120 },
  { id: "m5", senderId: SAM, body: "Great start. Before you build more, talk to 10 of those 40 people. Ask what they use *today*.", min: 60, pinned: true },
  { id: "m6", senderId: ME, body: `<@${MAYA}> want to swap interview notes this weekend?`, min: 12, reply: "m2", mentions: [MAYA] },
  { id: "m7", senderId: MAYA, body: `yes!! <@${ME}> Saturday 2pm?`, min: 4, mentions: [ME] },
  { id: "m8", senderId: DEV, body: "```ts\nconst signups = await db.from('waitlist').select('*');\n```\n> 40 rows, as promised", min: 2 },
  { id: "m9", senderId: MAYA, body: "🎉🎉", min: 1 },
];

function payloadFor(view: string): ChannelPayload | null {
  if (view === "empty") return null;
  const base = {
    hasMoreBefore: false,
    hasMoreAfter: false,
    people,
    pins: 1,
    focusId: null,
    draftTo: null,
    draftCompose: null,
    openThread: null,
    ask: null,
  };
  const info = {
    id: C(2),
    kind: "channel" as const,
    label: "general",
    name: "general",
    topic: "Say hi. Talk shop with everyone at batch0.",
    audience: "everyone" as const,
    posting: "everyone" as const,
    archived: false,
    slowmodeSeconds: 0,
    systemKey: "general",
    teamId: null,
    cohortId: null,
    otherId: null,
    memberIds: [],
    compose: { ok: true as const },
    // #announcements' readers react too (only posting is staff-only).
    canReact: true,
    canManage: false,
    canPin: false,
    canMentionEveryone: false,
    moderatorView: false,
    blockedByYou: false,
    notify: "mentions" as const,
    notifyIsDefault: true,
    slowmodeWait: 0,
    messageCount: msgs.length,
    threads: true,
    questionChannel: false,
    unanswered: 0,
  };
  const messages = msgs.map((m) => ({
    id: m.id,
    channelId: info.id,
    senderId: m.senderId,
    body: m.body,
    kind: "message" as const,
    replyTo: m.reply ? { id: m.reply, senderId: MAYA, preview: msgs.find((x) => x.id === m.reply)!.body, deleted: false } : null,
    mentions: m.mentions ?? [],
    mentionEveryone: false,
    attachments: [],
    reactions: m.reactions ?? {},
    createdAt: ago(m.min),
    editedAt: m.id === "m4" ? ago(100) : null,
    pinnedAt: m.pinned ? ago(50) : null,
  }));
  if (view === "draft") {
    return { ...base, channel: null, draftTo: people[SAM], draftCompose: { ok: false, reason: "Students and adults outside the batch0 team don't message each other privately. Mentors and students talk in team and cohort channels, where the batch0 team can see the conversation. For anything else, message the batch0 team." }, messages: [], cursor: new Date(0).toISOString(), pins: 0 };
  }
  if (view === "readonly") {
    return {
      ...base,
      channel: { ...info, id: C(1), label: "announcements", name: "announcements", posting: "staff", topic: "News from the batch0 team. Only staff post here.", compose: { ok: false, reason: "Only the batch0 team posts here." } },
      messages: messages.slice(0, 1).map((m) => ({ ...m, channelId: C(1) })),
      cursor: ago(500),
    };
  }
  if (view === "dm") {
    return {
      ...base,
      channel: { ...info, id: C(7), kind: "dm", label: "Maya Chen", name: null, topic: null, audience: "members", systemKey: null, otherId: MAYA, memberIds: [ME, MAYA], canPin: true, notify: "all" },
      messages: messages.filter((m) => m.senderId === MAYA || m.senderId === ME).map((m) => ({ ...m, channelId: C(7) })),
      cursor: ago(5),
    };
  }
  if (view === "help" || view === "thread" || view === "ask") {
    const help = { ...info, id: C(4), label: "help", name: "help", systemKey: "help", topic: "Stuck for twenty minutes? Ask here.", questionChannel: true, unanswered: 2 };
    return {
      ...base,
      channel: help,
      messages: helpMessages(),
      cursor: ago(500),
      pins: 0,
      openThread: view === "thread" ? { rootId: Q1, focusId: null } : null,
      ask:
        view === "ask"
          ? { kind: "lesson" as const, id: "l0000000-0000-4000-8000-000000000001", title: "Week 2 · Customer interviews", href: "/dashboard/course/l0000000-0000-4000-8000-000000000001" }
          : null,
    };
  }
  return { ...base, channel: info, messages, cursor: ago(13) };
}

const Q1 = "q0000000-0000-4000-8000-000000000001";
const Q2 = "q0000000-0000-4000-8000-000000000002";
const Q3 = "q0000000-0000-4000-8000-000000000003";

/** #help's feed: an open question with replies, one answered, one nobody has replied to (0110). */
function helpMessages() {
  const m = (id: string, senderId: string, body: string, min: number, thread?: ThreadSummary) => ({
    id,
    channelId: C(4),
    senderId,
    body,
    kind: "message" as const,
    replyTo: null,
    mentions: [],
    mentionEveryone: false,
    attachments: [],
    reactions: {},
    createdAt: ago(min),
    editedAt: null,
    pinnedAt: null,
    ...(thread ? { thread } : {}),
  });
  return [
    m(Q2, DEV, "Where's the interview script template?", 300, { replyCount: 1, lastReplyAt: ago(280), question: "answered", answerId: "r9" }),
    m(Q1, MAYA, "How should I recruit my first five interviewees? Nobody at school has replied to my form.", 90, {
      replyCount: 4,
      lastReplyAt: ago(8),
      question: "open",
      answerId: null,
      about: { kind: "lesson", id: "l0000000-0000-4000-8000-000000000001", title: "Week 2 · Customer interviews", href: "/dashboard/course/l0000000-0000-4000-8000-000000000001" },
    }),
    m(Q3, ME, "Is it ok to interview people I already know?", 20, { replyCount: 0, lastReplyAt: null, question: "open", answerId: null }),
  ];
}

export default async function ChatPreview(props: { searchParams?: Promise<{ view?: string }> }) {
  if (process.env.VERCEL_ENV === "production") notFound();
  const view = (await props.searchParams)?.view ?? "channel";
  return (
    <div className="fixed inset-0 z-10 flex bg-paper text-ink">
      <PreviewFetch channelId={C(4)} rootId={Q1} people={people} me={ME} maya={MAYA} sam={SAM} rish={RISH} dev={DEV} />
      <main id="main-content" className="flex min-h-0 w-full">
        <ChatApp
          viewer={{ id: ME, name: "Ava Patel", staff: false, vetted: true }}
          home="/dashboard"
          homeLabel="Dashboard"
          initialSidebar={sidebar}
          initialPayload={payloadFor(view)}
          initialError={null}
        />
      </main>
    </div>
  );
}
