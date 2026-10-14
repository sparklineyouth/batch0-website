import type { AdminGroup, EventType } from "@/lib/event-form";
import type { AudienceMode } from "@/lib/webinars";

/** One event as the admin list and form see it. Built in page.tsx. */
export type AdminEventRow = {
  id: string;
  title: string;
  description: string | null;
  type: EventType;
  cohortId: string | null;
  cohortName: string | null;
  startsAt: string;
  endsAt: string | null;
  location: string | null;
  /** Hosted covers legacy premiere rows: they run as hosted rooms now. */
  liveMode: "hosted" | "external";
  externalUrl: string | null;
  recordingUrl: string | null;
  visibility: "enrolled" | "public" | "staff";
  audienceMode: AudienceMode;
  autoRecord: boolean;
  autoShare: boolean;
  liveStartedAt: string | null;
  liveEndedAt: string | null;
  group: AdminGroup;
  roomAction: "Join" | "Start" | "Open room" | null;
  /** Names of hosts on air right now (live rows only). */
  hosting: string[];
  hasRecording: boolean;
};

export type CohortOption = { id: string; name: string };
