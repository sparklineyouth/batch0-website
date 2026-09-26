import { requirePermission } from "@/lib/auth";
import { Card } from "@/components/ui/card";
import { CallsPanel } from "@/components/live/calls-panel";
import { listInvitesForHost, listInvitableStudents } from "@/lib/calls";
import { countCallRecordings, recordingCandidates } from "@/lib/call-recordings";

export const metadata = { title: "1:1 calls · Investor" };

export default async function InvestorCallsPage() {
  const viewer = await requirePermission("calls.invite");
  const [invites, students] = await Promise.all([
    listInvitesForHost(viewer.profile.id),
    listInvitableStudents(),
  ]);
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
        Invite a founder to a private video call on batch0. They can accept or
        decline.
      </p>

      <Card className="mt-6">
        <CallsPanel
          invites={invites}
          students={students}
          now={now.toISOString()}
          recordings={recordings}
        />
      </Card>
    </div>
  );
}
