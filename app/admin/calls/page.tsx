import { requirePermission } from "@/lib/auth";
import { Card } from "@/components/ui/card";
import { CallsPanel } from "@/components/live/calls-panel";
import { InterviewRequestsPanel } from "@/components/live/interview-requests-panel";
import {
  listInvitesForHost,
  listAllInvites,
  listInvitableStudents,
} from "@/lib/calls";
import { listOpenInterviewRequests } from "@/lib/interview-requests";
import { ObservedCalls } from "./observed-calls";

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
  // meeting my students" without asking the participants.
  //
  // Observer cards, never host cards: an admin who is not one of the two
  // people in a 1:1 can never enter it (the room page 404s and joinRoom says
  // no-access for non-parties — the safeguarding rule and the privacy between
  // two people, both kept on purpose). So there is no Join here. "Admin is
  // always host" holds for the calls an admin BOOKS — those are in the panel
  // above, where they are the owner, with Join and End call.
  //
  // Cancelling someone else's call is normally the host's or the student's to
  // do. A superAdmin alone gets a Cancel, as the escalation path; cancelInvite
  // accepts exactly that, and it disconnects both people if the call is live.
  const others = all.filter((i) => !mine.some((m) => m.id === i.id));

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="font-display text-3xl font-bold tracking-[-0.02em] text-ink">
        1:1 calls
      </h1>
      <p className="mt-1 text-sm text-ink-faint">
        Invite a student to a private video call, and see every call mentors
        and investors have booked.
      </p>

      <Card className="mt-6">
        <CallsPanel invites={mine} students={students} />
      </Card>

      <section className="mt-10">
        <h2 className="mb-1 text-xs font-semibold uppercase tracking-[0.18em] text-ink-faint">
          Interview requests
        </h2>
        <p className="mb-3 text-sm text-ink-faint">
          Getting-to-know-you interviews students asked for before kickoff.
          Scheduling one books it as a 1:1 and emails them the time.
        </p>
        <InterviewRequestsPanel requests={interviewRequests} />
      </section>

      <section className="mt-10">
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-[0.18em] text-ink-faint">
          Booked by everyone else
        </h2>
        <ObservedCalls
          invites={others}
          canCancel={viewer.caps.superAdmin}
        />
      </section>
    </div>
  );
}
