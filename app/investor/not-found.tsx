import { NotFoundScreen } from "@/components/ui/not-found-screen";

export default function InvestorNotFound() {
  return (
    <NotFoundScreen
      variant="inline"
      title="Not available."
      body="That team isn't in the room. Teams appear here once their cohort reaches demo day and they opt in to being seen."
      homeHref="/investor"
      homeLabel="Back to the investor room"
    />
  );
}
