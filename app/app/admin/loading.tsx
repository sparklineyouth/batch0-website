import { ScreenSkeleton } from "@/components/app/skeleton";

/**
 * Shown the instant an admin tab is tapped, for every route under /app/admin.
 *
 * Two groups of two, because the admin surface leads with counts and Today
 * leads with two Sections of them — the queue, then the program. A single group
 * of two left the second section's ~270px unreserved, so the Recent list
 * dropped down the moment the real page arrived, on every launch of the app
 * from the admin start_url.
 *
 * Two each rather than the four Today can render, because this file has no
 * viewer and cannot know which tiles a permission set will produce — under-
 * reserving Today settles by growing, which is the cheaper direction.
 *
 * It is tuned for Today and Payments and is knowingly wrong for the rest. One
 * boundary covers eight routes, and Review, People, People detail, More,
 * At risk and Awaiting payment open with no stat grid at all, so they reserve
 * ~300px they never fill and their content jumps up when it lands. That is the
 * price of a single shared boundary, not a property of [2, 2]: the only real
 * fix is a loading.tsx per route, which is worth doing the next time someone
 * owns those files together. Today is the admin start_url and pays this cost
 * on every cold launch, so it is the one that gets the accurate reservation.
 */
export default function AdminAppLoading() {
  return <ScreenSkeleton tiles={[2, 2]} rows={4} />;
}
