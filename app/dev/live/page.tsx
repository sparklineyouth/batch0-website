import { notFound } from "next/navigation";
import { Harness } from "./harness";

/**
 * Live room harness: <LiveRoom/> on a fake session (canvas cameras and
 * screens, oscillator voices, in-memory chat), so every state can be looked at
 * and screenshotted without a server, a second browser or a camera.
 *
 *   /dev/live                         index of states
 *   /dev/live?state=<state>&w=<variant>[&media=real]
 *
 * Localhost only: it skips every guard the real rooms apply, so it 404s on
 * any Vercel deployment (production and preview). VERCEL_ENV is unset under
 * `next dev`; "development" is `vercel dev`.
 */
export const metadata = {
  title: "Live room harness · batch0",
  robots: { index: false, follow: false },
};

export default async function LiveHarnessPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const env = process.env.VERCEL_ENV;
  if (env === "production" || (env && env !== "development")) notFound();
  const sp = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
  return <Harness state={one(sp.state)} w={one(sp.w)} realMedia={one(sp.media) === "real"} />;
}
