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

  // The getting-to-know-you request is a pre-kickoff onboarding step for
  // enrolled students, so the form to ask only shows to an enrolled student
  // before their cohort starts. A request that's already in flight (requested
  // / scheduled) keeps showing whatever the phase, so a student never loses
  // track of one they filed.
  const showInterviewRequest =
    (access.enrolled && access.preCohort) || interviewRequest != null;

  // Deliberately not behind the enrolled gate that /dashboard/events uses.
  // An invite is addressed to one named person by someone who already decided
  // to reach them — an accepted applicant who is invited to a call should be
  // able to answer it, and hiding the page would leave them with an email and
  // nowhere to click.
  return (
    <StudentCalls
      invites={invites}
      interviewRequest={interviewRequest}
      showInterviewRequest={showInterviewRequest}
      scholarshipCall={scholarshipCall}
    />
  );
}
