import { requirePermission } from "@/lib/auth";
import { Card } from "@/components/ui/card";
import { CallsPanel } from "@/components/live/calls-panel";
import {
  listInvitesForHost,
  listInvitableStaff,
  listInvitableStudents,
} from "@/lib/calls";
import { countCallRecordings, recordingCandidates } from "@/lib/call-recordings";

export const metadata = { title: "1:1 calls · Mentor" };

export default async function MentorCallsPage() {
  const viewer = await requirePermission("calls.invite");
  const [invites, students, allStaff] = await Promise.all([
    // Calls they sent, and calls they were added to as a co-host.
    listInvitesForHost(viewer.profile.id),
    listInvitableStudents(),
    listInvitableStaff(),
  ]);
  // Everyone on the team but the viewer, who is already the host.
  const staff = allStaff.filter((s) => s.id !== viewer.profile.id);
  // One clock for the render: the Upcoming/Past split, the recording lookup
  // and the cards' first paint all agree on what "now" is.
  const now = new Date();
  const recordings = await countCallRecordings(recordingCandidates(invites, now));

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="font-display text-3xl font-bold tracking-[-0.02em] text-ink">
        1:1 calls
      </h1>
      <p className="mt-1 text-sm text-ink-faint">
        Invite a student to a private video call on batch0, and bring in
        anyone else from the team. They can accept or decline, and everyone
        joins here — no Zoom link to send.
      </p>

      <Card className="mt-6">
        <CallsPanel
          invites={invites}
          students={students}
          staff={staff}
          now={now.toISOString()}
          recordings={recordings}
        />
      </Card>
    </div>
  );
}
