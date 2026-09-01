import { NotFoundScreen } from "@/components/ui/not-found-screen";

export default function AdminAppNotFound() {
  return (
    <NotFoundScreen
      variant="inline"
      title="No such record."
      body="Nothing matches that id — it was probably deleted while this screen was open."
      homeHref="/app/admin"
      homeLabel="Go to Today"
    />
  );
}
