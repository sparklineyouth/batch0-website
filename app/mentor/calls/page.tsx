import { requirePermission } from "@/lib/auth";
import { Card } from "@/components/ui/card";
import { CallsPanel } from "@/components/live/calls-panel";
import { listInvitesForHost, listInvitableStaff, listInvitableStudents } from "@/lib/calls";

export const metadata = { title: "1:1 calls · Mentor" };

export default async function MentorCallsPage() {
  const viewer = await requirePermission("calls.invite");
  const [invites, students, allStaff] = await Promise.all([
    listInvitesForHost(viewer.profile.id),
    listInvitableStudents(),
    listInvitableStaff(),
  ]);

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="font-display text-3xl font-bold tracking-[-0.02em] text-ink">1:1 calls</h1>
      <p className="mt-1 text-sm text-ink-faint">Private video calls with students, recorded.</p>
      <Card className="mt-6">
        <CallsPanel
          invites={invites}
          students={students}
          staff={allStaff.filter((s) => s.id !== viewer.profile.id)}
          now={new Date().toISOString()}
        />
      </Card>
    </div>
  );
}
