import { requirePermission } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { Card } from "@/components/ui/card";
import { CallsPanel } from "@/components/live/calls-panel";
import { CallSections } from "@/components/live/invite-card";
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
  const [mine, all, students, allStaff, interviewRequests] = await Promise.all([
    // Calls this admin sent AND calls they were added to as a co-host.
    listInvitesForHost(viewer.profile.id),
    listAllInvites(),
    listInvitableStudents(),
    listInvitableStaff(),
    listOpenInterviewRequests(),
  ]);
  // Everyone on the team but the viewer, who is already the host of whatever
  // they book from this page, and already on every call listed in it. Each
  // card's Add people leaves out the rest of that call's people itself.
  const staff = allStaff.filter((s) => s.id !== viewer.profile.id);

  // Everything anyone else has booked. This is the safeguarding view: in a
  // programme of minors, someone has to be able to answer "who has been
  // meeting my students" without asking the participants. Read-only, with one
  // exception for a viewer holding calls.join_any (admins, through "*"): they
  // may put THEMSELVES on the call, as an ordinary co-host (addCallCohosts).
  // That is a way in that everyone can see — the student is told, and the
  // call names them like anyone else on it — never a way to watch unseen,
  // which the room still refuses to anyone not on the call. Cancelling
  // someone else's call stays with the people on it.
  const others = all.filter((i) => !mine.some((m) => m.id === i.id));
  const canJoinAny = can(viewer.caps, "calls.join_any");

  // One clock for the whole render. See the mentor page.
  const now = new Date();
  // Which queued requests are learner's-scholarship calls (migration 0071),
  // so they are not mistaken for onboarding interviews. Tolerant: an empty
  // set on a database without 0071.
  const scholarshipIds = await scholarshipFundedRequestIds(
    createAdminClient(),
    interviewRequests.map((r) => r.id),
  );

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="font-display text-3xl font-bold tracking-[-0.02em] text-ink">
        1:1 calls
      </h1>
      <p className="mt-1 text-sm text-ink-faint">
        Invite a student to a private video call — bringing in anyone else from
        the team — and see every call mentors and investors have booked. Every
        call is recorded; the people on it and admins can watch it back.
      </p>

      <Card className="mt-6">
        <CallsPanel
          invites={mine}
          students={students}
          staff={staff}
          now={now.toISOString()}
        />
      </Card>

      <section className="mt-10">
        <h2 className="mb-1 text-xs font-semibold uppercase tracking-[0.18em] text-ink-faint">
          Call requests
        </h2>
        <p className="mb-3 text-sm text-ink-faint">
          1:1s students asked for: enrolled students can ask whenever they want
          (a getting-to-know-you interview before kickoff, an ordinary call
          after), plus scholarship mentor calls. Confirming one of their times
          books it straight away; picking another sends it for them to accept.
        </p>
        <InterviewRequestsPanel
          requests={interviewRequests}
          staff={staff}
          now={now.toISOString()}
          scholarshipIds={[...scholarshipIds]}
        />
      </section>

      <section className="mt-10">
        <h2
          className={`${canJoinAny ? "mb-1" : "mb-3"} text-xs font-semibold uppercase tracking-[0.18em] text-ink-faint`}
        >
          Booked by everyone else
        </h2>
        {canJoinAny && (
          <p className="mb-3 text-sm text-ink-faint">
            Join call (or Add me, before it starts) puts you on a call as part
            of the team, for good. The student is told you&rsquo;re joining,
            and everyone on the call sees you.
          </p>
        )}
        <CallSections
          invites={others}
          perspective="observer"
          now={now.toISOString()}
          // Recordings of OTHER people's calls are for admins only — the rule
          // the recordings API enforces (canViewCallRecording); this page is
          // gated on calls.invite, which a custom role can hold.
          showRecordings={viewer.caps.superAdmin}
          emptyMessage="Nobody else has booked a 1:1 yet."
          viewerId={viewer.profile.id}
          canJoinAny={canJoinAny}
        />
      </section>
    </div>
  );
}
