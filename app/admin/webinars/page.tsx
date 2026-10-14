import { permanentRedirect } from "next/navigation";

// Webinars live on the one events page now; old links and bookmarks land there.
export default function AdminWebinarsPage() {
  permanentRedirect("/admin/events");
}
