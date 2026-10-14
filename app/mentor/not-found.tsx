import { NotFoundScreen } from "@/components/ui/not-found-screen";

export default function MentorNotFound() {
  return (
    <NotFoundScreen
      variant="inline"
      title="Not found."
      body="It doesn't exist, or isn't assigned to you."
      homeHref="/mentor"
      homeLabel="Back to mentor panel"
    />
  );
}
