import { ScreenSkeleton } from "@/components/app/skeleton";

/**
 * Shown the instant an admin tab is tapped, for every route under /app/admin.
 *
 * Two stat tiles because the admin surface leads with counts — Today opens on
 * the queue, and a skeleton that matches where the numbers land is what makes
 * the real content appear to fill in rather than replace.
 */
export default function AdminAppLoading() {
  return <ScreenSkeleton tiles={2} rows={4} />;
}
