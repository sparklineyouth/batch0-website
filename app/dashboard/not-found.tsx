import { NotFoundScreen } from "@/components/ui/not-found-screen";

/**
 * 404s inside the dashboard are almost never a bad URL — they're a lesson,
 * offer, or resource flow that was unpublished, or a row that belongs to
 * another student. The copy says that rather than implying a broken link.
 */
export default function DashboardNotFound() {
  return (
    <NotFoundScreen
      variant="inline"
      title="Not available."
      body="It may have been unpublished."
      homeHref="/dashboard"
      homeLabel="Back to dashboard"
    />
  );
}
