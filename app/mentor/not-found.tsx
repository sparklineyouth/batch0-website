import { NotFoundScreen } from "@/components/ui/not-found-screen";

export default function MentorNotFound() {
  return (
    <NotFoundScreen
      variant="inline"
      title="Not in your cohort."
      body="That student or team doesn't exist, or isn't assigned to you. Mentors only see the people in their own cohort."
      homeHref="/mentor"
      homeLabel="Back to mentor panel"
    />
  );
}
