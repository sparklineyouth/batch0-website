import type { Metadata } from "next";
import { requireViewer, roleHome } from "@/lib/auth";
import { isMissingSchemaError } from "@/lib/schema-ready";
import { isUuid } from "@/lib/chat-access";
import { buildSidebar, getChatViewer, type SidebarData } from "@/lib/chat";
import { buildChannelPayload, type ChannelPayload, type ChannelTarget } from "@/lib/chat-payload";
import { ChatApp } from "@/components/chat/chat-app";

export const metadata: Metadata = { title: "Chat · batch0", robots: { index: false } };
export const dynamic = "force-dynamic";

/**
 * batch0 Chat. A top-level route rather than /dashboard/chat for the reason
 * /notifications is: every role has chat, and /dashboard is gated on
 * `student.dashboard`, so a mentor following a "you were mentioned" bell into
 * /dashboard would be bounced straight back out. Middleware lists /chat as
 * signed-in only.
 *
 *   ?c=<channel>   open a channel, DM or group (the bell's link target)
 *   ?m=<message>   with ?c: open around that message and flash it
 *   ?to=<user>     open a DM with someone (a draft until the first message)
 *   ?team=<team>   open a team's channel (the Team page's "Team chat" link)
 *   ?thread=<msg>  with ?c: open that message's thread in the side pane (0110)
 *   ?ask=lesson:<id> | assignment:<id>
 *                  "Ask about this": open #help with that item linked in the
 *                  composer, when the viewer can open it (lib/chat-about.ts)
 */
export default async function ChatPage(props: {
  searchParams?: Promise<{ c?: string; m?: string; to?: string; team?: string; thread?: string; ask?: string }>;
}) {
  const sp = (await props.searchParams) ?? {};
  const { profile, caps } = await requireViewer();
  const home = await roleHome(profile.role);
  const homeLabel = home.startsWith("/admin") ? "Admin" : home.startsWith("/mentor") ? "Mentor panel" : home.startsWith("/investor") ? "Investor panel" : "Dashboard";

  let viewer;
  let sidebar: SidebarData;
  try {
    viewer = await getChatViewer(profile.id, caps);
    // The sidebar's people include the viewer: their own name, for the footer.
    sidebar = await buildSidebar(viewer);
  } catch (err) {
    return <Unavailable home={home} homeLabel={homeLabel} missing={isMissingSchemaError(err)} />;
  }

  const target: ChannelTarget | null = isUuid(sp.c)
    ? { channelId: sp.c, around: isUuid(sp.m) ? sp.m : null, thread: isUuid(sp.thread) ? sp.thread : null }
    : isUuid(sp.to)
      ? { withUserId: sp.to }
      : isUuid(sp.team)
        ? { teamId: sp.team }
        : typeof sp.ask === "string" && sp.ask
          ? { systemKey: "help", ask: sp.ask.slice(0, 100) }
          : null;

  let payload: ChannelPayload | null = null;
  let error: string | null = null;
  if (target) {
    payload = await buildChannelPayload(viewer, target).catch(() => null);
    if (!payload) error = "That conversation isn't available. It may not exist, or you may not be in it.";
  }
  // No target: open #general when it's readable (a phone shows the list first anyway).
  if (!payload && !target) {
    const first =
      sidebar.channels.find((c) => c.systemKey === "general") ??
      sidebar.channels.find((c) => c.unread > 0) ??
      sidebar.channels[0] ??
      sidebar.conversations[0];
    if (first) payload = await buildChannelPayload(viewer, { channelId: first.id }).catch(() => null);
  }

  const me = sidebar.people[profile.id];

  return (
    // A fixed, full-viewport surface: each pane scrolls on its own, the
    // composer stays pinned to the bottom of the screen.
    <div className="fixed inset-0 z-10 flex bg-paper pl-[var(--safe-left)] pr-[var(--safe-right)] text-ink">
      <main id="main-content" tabIndex={-1} className="flex min-h-0 w-full">
        <ChatApp
          viewer={{ id: profile.id, name: me?.name ?? profile.full_name ?? "You", staff: viewer.staff, vetted: viewer.vetted }}
          home={home}
          homeLabel={homeLabel}
          initialSidebar={sidebar}
          initialPayload={payload}
          initialError={error}
        />
      </main>
    </div>
  );
}

function Unavailable({ home, homeLabel, missing }: { home: string; homeLabel: string; missing: boolean }) {
  return (
    <main id="main-content" className="mx-auto max-w-xl px-5 py-16">
      <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-phosphor-ink">Chat</p>
      <h1 className="mt-3 font-display text-4xl text-ink">{missing ? "Chat isn't set up yet" : "Chat didn't load"}</h1>
      <p className="mt-3 text-ink-soft">
        {missing
          ? "The batch0 team is turning it on. Check back soon."
          : "Something went wrong loading your conversations. Refresh in a moment."}
      </p>
      <a href={home} className="link-ink mt-6 inline-block text-sm">
        ← Back to {homeLabel}
      </a>
    </main>
  );
}
