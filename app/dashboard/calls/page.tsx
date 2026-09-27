import { requireUser, getProfile } from "@/lib/auth";
import { listInvitesForInvitee } from "@/lib/calls";
import { getInterviewRequestForStudent } from "@/lib/interview-requests";
import { getStudentAccess } from "@/lib/access";
import type { Role } from "@/lib/types";
import { StudentCalls } from "./student-calls";
import { createAdminClient } from "@/lib/supabase/admin";
import { callCreditsForUser } from "@/lib/scholarships";
import { windowUntilLabel } from "@/lib/scholarship-window";
import type { ScholarshipCallState } from "@/components/scholarship-call-card";
import {
  canRequestTeamCall,
  interviewCardState,
  interviewStage,
} from "@/lib/call-lifecycle";
import { countCallRecordings, recordingCandidates } from "@/lib/call-recordings";

export const metadata = { title: "1:1 calls · batch0" };

export default async function StudentCallsPage() {
  await requireUser();
  const profile = await getProfile();
  const access = await getStudentAccess((profile?.role as Role) ?? "student");
  const [invites, interviewRequest, callAward] = await Promise.all([
    profile ? listInvitesForInvitee(profile.id) : Promise.resolve([]),
    profile ? getInterviewRequestForStudent(profile.id) : Promise.resolve(null),
    // The learner's-scholarship balance (migration 0071). Read through the
    // service-role client: scholarship_applications has no write policy, and
    // its read policy would otherwise make "no award" and "RLS said no"
    // indistinguishable — a student's own credits silently reading as absent
    // is exactly the failure this card exists to prevent.
    profile
      ? callCreditsForUser(createAdminClient(), profile.id)
      : Promise.resolve(null),
  ]);

  const scholarshipCall: ScholarshipCallState | null = callAward
    ? {
        scholarshipName: callAward.scholarshipName,
        granted: callAward.credits.granted,
        remaining: callAward.credits.remaining,
        // One open ask at a time (interview_requests_one_open_per_student,
        // migration 0061) — so the card says so rather than letting them hit
        // a duplicate-key error they can't interpret.
        hasOpenRequest: interviewRequest?.status === "requested",
        // The calls belong to the cohort the award was made in. Once it has
        // ended the card says so instead of offering a booking the action
        // would refuse; while it runs, the card names the last bookable day.
        closedReason: callAward.window.open ? null : callAward.window.reason,
        bookableUntil: callAward.window.open ? callAward.window.until : null,
        bookableUntilLabel:
          callAward.window.open && callAward.window.until
            ? windowUntilLabel(callAward.window.until)
            : null,
        cohortName: callAward.window.open ? callAward.window.cohortName : null,
      }
    : null;

  // One clock for the render — the Upcoming/Past split, the interview card and
  // the recording lookup all agree on what "now" is.
  const now = new Date();

  // Any enrolled student can ask the team for a 1:1 whenever they want, and
  // the team confirms a time. Before kickoff it is the getting-to-know-you
  // interview, after it an ordinary call. A request already in flight keeps
  // showing whatever the phase, read through the call it booked
  // (interviewStage): one still marked scheduled whose call was cancelled is
  // NOT booked, and one whose call already happened gives way to a fresh ask.
  // Staff previewing the page can't file one (the action refuses them), so
  // they don't get the form.
  const interviewLastStage = interviewStage(interviewRequest, now);
  const interviewState = interviewCardState(
    interviewLastStage,
    canRequestTeamCall(access),
  );

  const recordings = profile
    ? await countCallRecordings(recordingCandidates(invites, now))
    : {};

  // Deliberately not behind the enrolled gate that /dashboard/events uses.
  // An invite is addressed to one named person by someone who already decided
  // to reach them — an accepted applicant who is invited to a call should be
  // able to answer it, and hiding the page would leave them with an email and
  // nowhere to click.
  return (
    <StudentCalls
      invites={invites}
      now={now.toISOString()}
      recordings={recordings}
      interviewRequest={interviewRequest}
      interviewState={interviewState}
      interviewKind={access.preCohort ? "interview" : "call"}
      interviewLastStage={interviewLastStage}
      scholarshipCall={scholarshipCall}
    />
  );
}
