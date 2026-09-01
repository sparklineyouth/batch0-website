"use client";
import { useEffect, useState } from "react";
import { PreJoin } from "@/components/live/pre-join";
import { CallStage } from "@/components/live/call-stage";
import { EventCard } from "@/components/live/event-card";
import { InviteForm } from "@/components/live/invite-form";
import { InviteList } from "@/components/live/invite-card";
import { WebinarsManager } from "@/app/admin/webinars/webinars-manager";
import type { CallInvite, LiveEvent, LiveRole } from "@/lib/live";
import { Button } from "@/components/ui/button";

const TABS = [
  { id: "events", label: "Events page" },
  { id: "prejoin", label: "Green room" },
  { id: "webinar", label: "Webinar" },
  { id: "call", label: "1:1 call" },
  { id: "invite", label: "Send an invite" },
  { id: "invites", label: "Invite lists" },
  { id: "admin", label: "Webinars admin" },
] as const;

type TabId = (typeof TABS)[number]["id"];

export function LivePreview() {
  // Mock timestamps are relative to "now", which the server and the client
  // disagree about. Building them after mount sidesteps a hydration mismatch
  // without having to freeze the clock and lose the live/soon/past states
  // that are the whole point of previewing these cards.
  const [mocks, setMocks] = useState<Mocks | null>(null);
  useEffect(() => setMocks(buildMocks()), []);

  const [tab, setTab] = useState<TabId>("events");
  const [role, setRole] = useState<LiveRole>("host");

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <header className="mb-6">
        <h1 className="font-display text-3xl font-semibold tracking-[-0.02em] text-ink">
          Live video — interface preview
        </h1>
        <p className="mt-1.5 text-sm text-ink-soft">
          Every screen, on mock data, with no provider connected. Your camera
          and mic are real. Dev-only route.
        </p>
      </header>

      <nav className="mb-6 flex flex-wrap gap-2 border-b border-line pb-3">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
              tab === t.id
                ? "bg-phosphor text-on-phosphor font-semibold"
                : "text-ink-soft hover:bg-wash hover:text-ink"
            }`}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {(tab === "prejoin" || tab === "webinar") && (
        <div className="mb-5 flex items-center gap-2">
          <span className="text-xs uppercase tracking-wider text-ink-faint">
            View as
          </span>
          <Button
            size="sm"
            variant={role === "host" ? "primary" : "secondary"}
            onClick={() => setRole("host")}
          >
            Host
          </Button>
          <Button
            size="sm"
            variant={role === "viewer" ? "primary" : "secondary"}
            onClick={() => setRole("viewer")}
          >
            Student
          </Button>
        </div>
      )}

      {!mocks ? (
        <p className="text-sm text-ink-faint">Loading preview…</p>
      ) : (
        <>
          {tab === "events" && (
            <section className="space-y-6">
              <div>
                <SectionLabel>Upcoming</SectionLabel>
                <div className="space-y-3">
                  {mocks.events.map((e) => (
                    <EventCard key={e.id} event={e} upcoming />
                  ))}
                </div>
              </div>
              <div>
                <SectionLabel>Past</SectionLabel>
                <EventCard event={mocks.pastEvent} upcoming={false} />
              </div>
            </section>
          )}

          {tab === "prejoin" && (
            <PreJoin
              key={role}
              title="Fundraising 101 with the batch0 team"
              subtitle="Workshop · 60 minutes · 24 students invited"
              role={role}
              onJoin={() => alert("Would enter the room")}
              joinLabel={role === "host" ? "Start the webinar" : "Join webinar"}
            />
          )}

          {tab === "webinar" && (
            <CallStage
              key={role}
              title="Fundraising 101 with the batch0 team"
              role={role}
              layout="spotlight"
              participants={mocks.webinarParticipants}
              onLeave={() => alert("Would leave the room")}
            />
          )}

          {tab === "call" && (
            <CallStage
              title="1:1 with Priya Raman"
              role="host"
              layout="grid"
              participants={[
                { id: "me", name: "You", role: "host" },
                { id: "p1", name: "Priya Raman", role: "host" },
              ]}
              onLeave={() => alert("Would leave the call")}
            />
          )}

          {tab === "invite" && (
            <div className="max-w-xl">
              <SectionLabel>Invite a student to a 1:1</SectionLabel>
              <InviteForm
                students={mocks.students}
                onSubmit={(d) =>
                  alert(`Would invite ${d.inviteeId} for ${d.durationMinutes}m`)
                }
              />
            </div>
          )}

          {tab === "admin" && (
            <div>
              <SectionLabel>
                What an admin sees at /admin/webinars
              </SectionLabel>
              <WebinarsManager
                live={mocks.events
                  .filter((e) => e.id === "e-live")
                  .map((e) => ({ ...e, visibility: "enrolled" }))}
                upcoming={mocks.events
                  .filter((e) => ["e-soon", "e-later"].includes(e.id))
                  .map((e) => ({ ...e, visibility: "staff" }))}
                past={[{ ...mocks.pastEvent, visibility: "enrolled" }]}
                cohorts={[{ id: "c1", name: "Cohort 1" }]}
              />
            </div>
          )}

          {tab === "invites" && (
            <div className="space-y-8">
              <div>
                <SectionLabel>
                  What a mentor or investor sees — invites they sent
                </SectionLabel>
                <InviteList
                  invites={mocks.invites}
                  perspective="host"
                  emptyMessage="You haven't invited anyone yet."
                  onCancel={(id) => alert(`Would cancel ${id}`)}
                />
              </div>
              <div>
                <SectionLabel>
                  What a student sees — invites they received
                </SectionLabel>
                <InviteList
                  invites={mocks.invites}
                  perspective="invitee"
                  emptyMessage="No call invites right now."
                  onAccept={(id) => alert(`Would accept ${id}`)}
                  onDecline={(id) => alert(`Would decline ${id}`)}
                />
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mb-3 text-xs font-semibold uppercase tracking-[0.18em] text-ink-faint">
      {children}
    </h2>
  );
}

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

type Mocks = {
  events: LiveEvent[];
  pastEvent: LiveEvent;
  invites: CallInvite[];
  students: Parameters<typeof InviteForm>[0]["students"];
  webinarParticipants: Parameters<typeof CallStage>[0]["participants"];
};

function buildMocks(): Mocks {
  const min = 60_000;
  const at = (minutes: number) =>
    new Date(Date.now() + minutes * min).toISOString();

  const baseEvent = {
    description: null,
    location: null,
    recordingUrl: null,
    roomName: null,
    roomUrl: null,
    externalUrl: null,
  };

  return {
    events: [
      {
        ...baseEvent,
        id: "e-live",
        title: "Fundraising 101",
        description:
          "How pre-seed rounds actually work, and what to say when an investor asks about traction.",
        type: "workshop",
        // Started 10 minutes ago — exercises the live state.
        startsAt: at(-10),
        endsAt: at(50),
        liveMode: "hosted",
        hostName: "Shresht",
      },
      {
        ...baseEvent,
        id: "e-soon",
        title: "Office hours: pitch practice",
        type: "office_hours",
        // Inside the 15-minute early window — joinable, not yet started.
        startsAt: at(8),
        endsAt: at(68),
        liveMode: "hosted",
        hostName: "Priya Raman",
      },
      {
        ...baseEvent,
        id: "e-later",
        title: "Demo Day rehearsal",
        description: "Run your five minutes in front of the whole cohort.",
        type: "demo_day",
        startsAt: at(60 * 26),
        endsAt: at(60 * 28),
        liveMode: "hosted",
        hostName: "Shresht",
      },
      {
        ...baseEvent,
        id: "e-zoom",
        title: "Guest AMA — external Zoom link",
        description:
          "Unchanged legacy behaviour: a pasted link still opens in a new tab.",
        type: "other",
        startsAt: at(60 * 50),
        endsAt: null,
        liveMode: "external",
        externalUrl: "https://zoom.us/j/example",
        hostName: null,
      },
    ],
    pastEvent: {
      ...baseEvent,
      id: "e-past",
      title: "Kickoff call",
      type: "other",
      startsAt: at(-60 * 24 * 7),
      endsAt: at(-60 * 24 * 7 + 60),
      liveMode: "hosted",
      recordingUrl: "https://example.com/recording",
      hostName: "Shresht",
    },
    invites: [
      {
        id: "i-live",
        hostName: "Priya Raman",
        hostRole: "investor",
        inviteeName: "Ana Duarte",
        startsAt: at(-5),
        durationMinutes: 30,
        topic: "Seed round questions",
        status: "accepted",
        roomName: null,
        roomUrl: null,
      },
      {
        id: "i-pending",
        hostName: "Marcus Webb",
        hostRole: "mentor",
        inviteeName: "Ana Duarte",
        startsAt: at(60 * 30),
        durationMinutes: 45,
        topic: "Portfolio review before Demo Day",
        status: "invited",
        roomName: null,
        roomUrl: null,
      },
      {
        id: "i-accepted",
        hostName: "Shresht",
        hostRole: "admin",
        inviteeName: "Ana Duarte",
        startsAt: at(60 * 72),
        durationMinutes: 20,
        topic: null,
        status: "accepted",
        roomName: null,
        roomUrl: null,
      },
      {
        id: "i-declined",
        hostName: "Marcus Webb",
        hostRole: "mentor",
        inviteeName: "Ana Duarte",
        startsAt: at(-60 * 48),
        durationMinutes: 30,
        topic: "Intro chat",
        status: "declined",
        roomName: null,
        roomUrl: null,
      },
    ],
    students: [
      {
        id: "s1",
        name: "Ana Duarte",
        email: "ana@example.com",
        teamName: "Loop",
      },
      {
        id: "s2",
        name: "Ben Okafor",
        email: "ben@example.com",
        teamName: "Loop",
      },
      {
        id: "s3",
        name: "Chen Wei",
        email: "chen@example.com",
        teamName: "Notebook",
      },
      {
        id: "s4",
        name: "Dara Singh",
        email: "dara@example.com",
        teamName: null,
      },
      {
        id: "s5",
        name: "Eli Marsh",
        email: "eli@example.com",
        teamName: "Notebook",
      },
    ],
    webinarParticipants: [
      { id: "h1", name: "Shresht", role: "host" },
      { id: "v1", name: "Ana Duarte", role: "viewer" },
      { id: "v2", name: "Ben Okafor", role: "viewer" },
      { id: "v3", name: "Chen Wei", role: "viewer" },
      { id: "v4", name: "Dara Singh", role: "viewer" },
    ],
  };
}
