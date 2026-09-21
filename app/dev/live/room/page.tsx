import { notFound } from "next/navigation";
import Link from "next/link";
import { createRoom, dailyConfigured, mintToken } from "@/lib/daily";
import { env } from "@/lib/env";
import type { LiveRole } from "@/lib/live";
import { LiveRoom } from "@/app/dashboard/events/[id]/live/live-room";

/**
 * The real webinar room, against a real Daily room, with no database.
 *
 * /dev/live shows the interface on mock data. This shows the *actual*
 * LiveRoom component — real SDK, real room, real token — which is the only
 * way to exercise the join path on a machine whose .env.local has placeholder
 * Supabase credentials. Without it, the webinar can only be tested by
 * deploying, which is a slow loop for a screen this fiddly.
 *
 *   /dev/live/room            → join as the host (camera and mic live)
 *   /dev/live/room?role=viewer → join as a hidden viewer
 *
 * Open both in two browsers to see the split: the host has a participants bar
 * and the viewer has none, and the host cannot see the viewer in the roster
 * either, because a hidden participant is absent from everyone's list.
 *
 * Dev-only, by the same VERCEL_ENV rule as /dev/live — it mints tokens with no
 * permission check at all, which is only acceptable somewhere it cannot exist.
 */
export const metadata = {
  title: "Live room test · batch0",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/**
 * One room per server process, reused until it expires.
 *
 * Creating a room per page load would litter the Daily domain during a normal
 * edit-refresh loop, and — more usefully — reusing one means two browser tabs
 * opened seconds apart land in the SAME room, which is the entire point of
 * testing a webinar.
 */
let cached: { name: string; url: string; expiresAt: number } | null = null;

async function devRoom() {
  const now = Date.now();
  if (cached && cached.expiresAt > now + 60_000) return cached;
  const room = await createRoom({
    namePrefix: "dev-webinar",
    mode: "webinar",
    expiresAt: new Date(now + 2 * 60 * 60 * 1000),
  });
  cached = { ...room, expiresAt: now + 2 * 60 * 60 * 1000 };
  return cached;
}

export default async function DevLiveRoomPage(
  props: {
    searchParams: Promise<{ role?: string }>;
  }
) {
  const searchParams = await props.searchParams;
  if (process.env.VERCEL_ENV === "production") notFound();

  // This page is the DAILY room, and only that. It predates batch0 Live and
  // is kept for the day the Daily account has a card on file again — but on
  // the default provider it would mint a token against an account that
  // refuses every media session, and hand back
  // `account-missing-payment-method` at the join. Say which room you are
  // asking for instead, and point at the one that works.
  if (env.liveProvider !== "daily") {
    return (
      <Notice title="This is the Daily test room">
        LIVE_PROVIDER is not set to <code>daily</code>, so webinars run on
        batch0 Live and this page would join a Daily account that refuses
        every media session. Open a real webinar at{" "}
        <code>/dashboard/events/[id]/live</code>, or run{" "}
        <code>npm run webinar-e2e</code> to drive two browsers through one.
      </Notice>
    );
  }

  if (!dailyConfigured()) {
    return (
      <Notice title="Daily isn't configured">
        Set DAILY_API_KEY and NEXT_PUBLIC_DAILY_DOMAIN in .env.local.
      </Notice>
    );
  }

  const role: LiveRole = searchParams.role === "viewer" ? "viewer" : "host";
  const room = await devRoom();
  const token = await mintToken({
    roomName: room.name,
    userId: `dev-${role}`,
    userName: role === "host" ? "Dev Host" : "Dev Student",
    role,
    expiresAt: new Date(room.expiresAt),
  });

  return (
    <div className="px-4 py-6">
      <nav className="mx-auto mb-4 flex max-w-6xl items-center gap-3 text-xs">
        <span className="font-mono uppercase tracking-wider text-ink-faint">
          dev · {room.name}
        </span>
        <Link
          href="/dev/live/room"
          className={role === "host" ? "text-phosphor-ink" : "text-ink-faint hover:text-ink"}
        >
          host
        </Link>
        <Link
          href="/dev/live/room?role=viewer"
          className={
            role === "viewer" ? "text-phosphor-ink" : "text-ink-faint hover:text-ink"
          }
        >
          viewer
        </Link>
      </nav>
      <LiveRoom
        title="Fundraising 101 — dev room"
        roomUrl={room.url}
        token={token}
        role={role}
        backHref="/dev/live"
      />
    </div>
  );
}

function Notice({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mx-auto max-w-lg px-4 py-16 text-center">
      <h1 className="font-display text-xl font-semibold text-ink">{title}</h1>
      <p className="mt-2 text-sm text-ink-soft">{children}</p>
    </div>
  );
}
