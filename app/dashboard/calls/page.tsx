import { requireUser, getProfile } from "@/lib/auth";
import { listInvitesForInvitee } from "@/lib/calls";
import { getInterviewRequestForStudent } from "@/lib/interview-requests";
import { getStudentAccess } from "@/lib/access";
import type { Role } from "@/lib/types";
import { StudentCalls } from "./student-calls";
import { createAdminClient } from "@/lib/supabase/admin";
import { callCreditsForUser, scholarshipApplicationIdForRequest } from "@/lib/scholarships";
import type { ScholarshipCallState } from "@/components/interview-request-card";
import { canRequestTeamCall, requestCardState } from "@/lib/call-lifecycle";

export const metadata = { title: "1:1 calls · batch0" };

// Not behind the enrolled gate: a call is addressed to one named person, and
// an accepted applicant who is booked into one must be able to join it.
export default async function StudentCallsPage() {
  await requireUser();
  const profile = await getProfile();
  const access = await getStudentAccess((profile?.role as Role) ?? "student");
  const admin = createAdminClient();
  const [invites, request, callAward] = await Promise.all([
    profile ? listInvitesForInvitee(profile.id) : Promise.resolve([]),
    profile ? getInterviewRequestForStudent(profile.id) : Promise.resolve(null),
    // Service role: "no award" and "RLS said no" must not look the same.
    profile ? callCreditsForUser(admin, profile.id) : Promise.resolve(null),
  ]);

  const now = new Date();
  const state = requestCardState(request, canRequestTeamCall(access));
  const requestIsScholarship =
    state === "requested" && request
      ? !!(await scholarshipApplicationIdForRequest(admin, request.id))
      : false;

  const scholarship: ScholarshipCallState | null = callAward
    ? {
        scholarshipName: callAward.scholarshipName,
        granted: callAward.credits.granted,
        remaining: callAward.credits.remaining,
        closedReason: callAward.window.open ? null : callAward.window.reason,
        bookableUntil: callAward.window.open ? callAward.window.until : null,
      }
    : null;

  return (
    <StudentCalls
      invites={invites}
      now={now.toISOString()}
      request={request}
      requestState={state}
      requestIsScholarship={requestIsScholarship}
      scholarship={scholarship}
    />
  );
}
