import { notFound } from "next/navigation";
import { DrivePreviewHarness } from "./preview";

/**
 * Interface preview for the team drive.
 *
 * The drive itself lives behind sign-in on /dashboard/team (members),
 * /mentor/teams/[id], /investor/teams/[id] and /admin/teams/[id], which
 * makes the upload zone and the preview dialog awkward to look at while
 * iterating. This renders both against fixed mock rows and locally made
 * blob URLs — no auth, no database, no storage bucket.
 *
 * Gated on VERCEL_ENV: it renders on localhost and on branch deployments and
 * 404s on the real site. Not NODE_ENV, which Vercel sets to "production" for
 * every deployment, previews included.
 */
export const metadata = {
  title: "Team drive preview · batch0",
  robots: { index: false, follow: false },
};

export default function DrivePreviewPage() {
  if (process.env.VERCEL_ENV === "production") notFound();
  return <DrivePreviewHarness />;
}
