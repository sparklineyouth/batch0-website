import { NotFoundScreen } from "@/components/ui/not-found-screen";

/**
 * Every `notFound()` under /admin is a record that isn't there — a deleted
 * cohort, a template someone else removed, an id pasted from another
 * environment. Naming that is more useful than "page not found."
 */
export default function AdminNotFound() {
  return (
    <NotFoundScreen
      variant="inline"
      title="No such record."
      body="Nothing matches that id. It was probably deleted, or the link came from a different environment."
      homeHref="/admin"
      homeLabel="Back to admin"
    />
  );
}
