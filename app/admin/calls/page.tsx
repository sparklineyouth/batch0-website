import { requirePermission } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { Card } from "@/components/ui/card";
import { CallsPanel } from "@/components/live/calls-panel";
import { CallSections, Fold } from "@/components/live/invite-card";
import { InterviewRequestsPanel } from "@/components/live/interview-requests-panel";
import {
  listInvitesForHost,
  listAllInvites,
  listInvitableStaff,
  listInvitableStudents,
} from "@/lib/calls";
import { listOpenInterviewRequests } from "@/lib/interview-requests";
import { scholarshipFundedRequestIds } from "@/lib/scholarships";
import { createAdminClient } from "@/lib/supabase/admin";

export const metadata = { title: "1:1 calls · Admin" };

export default async function AdminCallsPage() {
  const viewer = await requirePermission("calls.invite");
  const [mine, all, students, allStaff, requests] = await Promise.all([
    listInvitesForHost(viewer.profile.id),
    listAllInvites(),
    listInvitableStudents(),
    listInvitableStaff(),
    listOpenInterviewRequests(),
  ]);
  const staff = allStaff.filter((s) => s.id !== viewer.profile.id);
  // Everyone else's calls: the safeguarding view. Read-only, except that a
  // calls.join_any holder may add THEMSELVES (the student is told). Other
  // people's recordings are for admins only (canViewCallRecording).
  const others = all.filter((i) => !mine.some((m) => m.id === i.id));
  const canJoinAny = can(viewer.caps, "calls.join_any");
  const scholarshipIds = await scholarshipFundedRequestIds(
    createAdminClient(),
    requests.map((r) => r.id),
  );
  const now = new Date().toISOString();

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="font-display text-3xl font-bold tracking-[-0.02em] text-ink">1:1 calls</h1>

      <Card className="mt-6">
        <CallsPanel invites={mine} students={students} staff={staff} now={now} />
      </Card>

      <section className="mt-10">
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-[0.18em] text-ink-faint">
          Requests
        </h2>
        <InterviewRequestsPanel
          requests={requests}
          staff={staff}
          now={now}
          scholarshipIds={[...scholarshipIds]}
        />
      </section>

      <Fold label="Booked by everyone else" count={others.length} className="mt-10">
        <CallSections
          invites={others}
          perspective="observer"
          now={now}
          showRecording={viewer.caps.superAdmin}
          emptyMessage="Nothing coming up."
          viewerId={viewer.profile.id}
          canJoinAny={canJoinAny}
        />
      </Fold>
    </div>
  );
}
