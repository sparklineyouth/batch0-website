import { ScreenSkeleton } from "@/components/app/skeleton";

/**
 * Shown the instant a student tab is tapped, for every route under (student).
 *
 * One boundary for all four tabs rather than a per-route file: they share a
 * shape (header, a section or two, a list), and four near-identical skeletons
 * would drift the moment one screen's spacing changed.
 */
export default function StudentAppLoading() {
  return <ScreenSkeleton rows={5} />;
}
