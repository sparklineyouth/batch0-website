import { NotFoundScreen } from "@/components/ui/not-found-screen";

export default function StudentAppNotFound() {
  return (
    <NotFoundScreen
      variant="inline"
      title="Not available."
      body="This screen doesn't exist, or it isn't part of your program right now."
      homeHref="/app/home"
      homeLabel="Go to Home"
    />
  );
}
