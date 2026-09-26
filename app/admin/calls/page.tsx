import { requirePermission } from "@/lib/auth";
import { Card } from "@/components/ui/card";
import { CallsPanel } from "@/components/live/calls-panel";
import { CallSections } from "@/components/live/invite-card";
import { InterviewRequestsPanel } from "@/components/live/interview-requests-panel";
import {
  listInvitesForHost,
  listAllInvites,
  listInvitableStudents,
} from "@/lib/calls";
import { listOpenInterviewRequests } from "@/lib/interview-requests";
import { countCallRecordings, recordingCandidates } from "@/lib/call-recordings";
import { scholarshipFundedRequestIds } from "@/lib/scholarships";
import { createAdminClient } from "@/lib/supabase/admin";

export const metadata = { title: "1:1 calls · Admin" };

export default async function AdminCallsPage() {
  const viewer = await requirePermission("calls.invite");
  const [mine, all, students, interviewRequests] = await Promise.all([
    listInvitesForHost(viewer.profile.id),
    listAllInvites(),
    listInvitableStudents(),
    listOpenInterviewRequests(),
  ]);

  // Everything anyone else has booked. This is the safeguarding view: in a
  // programme of minors, someone has to be able to answer "who has been
  // meeting my students" without asking the participants. Read-only —
  // cancelling someone else's call is the host's or the student's to do.
  const others = all.filter((i) => !mine.some((m) => m.id === i.id));

  // One clock for the whole render. See the mentor page.
  const now = new Date();
  // Recordings of OTHER people's calls are for admins only — the same rule the
  // playback route enforces (canViewCallRecording). This page is gated on
  // calls.invite, which a custom role can hold without being an admin, and
  // such a viewer must not even be shown that a recording exists.
  const [myRecordings, otherRecordings, scholarshipIds] = await Promise.all([
    countCallRecordings(recordingCandidates(mine, now)),
    viewer.caps.superAdmin
      ? countCallRecordings(recordingCandidates(others, now))
      : Promise.resolve(undefined),
    // Which queued requests are learner's-scholarship calls (migration 0071),
    // so they are not mistaken for onboarding interviews. Tolerant: an empty
    // set on a database without 0071.
    scholarshipFundedRequestIds(
      createAdminClient(),
      interviewRequests.map((r) => r.id),
    ),
  ]);

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="font-display text-3xl font-bold tracking-[-0.02em] text-ink">
        1:1 calls
      </h1>
      <p className="mt-1 text-sm text-ink-faint">
        Invite a student to a private video call, and see every call mentors
        and investors have booked. Every call is recorded; the two people on it
        and admins can watch it back.
      </p>

      <Card className="mt-6">
        <CallsPanel
          invites={mine}
          students={students}
          now={now.toISOString()}
          recordings={myRecordings}
        />
      </Card>

      <section className="mt-10">
        <h2 className="mb-1 text-xs font-semibold uppercase tracking-[0.18em] text-ink-faint">
          Interview requests
        </h2>
        <p className="mb-3 text-sm text-ink-faint">
          Getting-to-know-you interviews students asked for before kickoff, and
          scholarship mentor calls. Scheduling one books it as a 1:1 and emails
          them the time.
        </p>
        <InterviewRequestsPanel
          requests={interviewRequests}
          now={now.toISOString()}
          scholarshipIds={[...scholarshipIds]}
        />
      </section>

      <section className="mt-10">
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-[0.18em] text-ink-faint">
          Booked by everyone else
        </h2>
        <CallSections
          invites={others}
          perspective="observer"
          now={now.toISOString()}
          recordings={otherRecordings}
          emptyMessage="Nobody else has booked a 1:1 yet."
        />
      </section>
    </div>
  );
}
