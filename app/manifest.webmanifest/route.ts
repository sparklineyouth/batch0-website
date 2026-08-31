import { headers } from "next/headers";
import { isAppHost } from "@/lib/app-host";

/**
 * The web app manifest — what turns a browser tab into a home-screen app.
 *
 * A route handler rather than Next's `app/manifest.ts` convention, because the
 * one field that matters most here has to differ per host. `start_url` is what
 * the home-screen icon opens, and the app is reachable from two places:
 *
 *   app.batch0.org — the whole origin is the app, so start_url is "/", which
 *   the middleware sends to /app. Installing here is the intended path.
 *
 *   batch0.org/app — the app is one subtree of the marketing site, so start_url
 *   must be "/app". A shared static manifest would have to pick one of these,
 *   and picking "/" would mean installing from the apex gives you an icon that
 *   opens the homepage.
 *
 * `scope` stays "/" on both. Narrowing it to /app would look tidier and would
 * break the app: every "open the full dashboard" link in the More screens
 * points outside /app, and an out-of-scope link opens in the system browser
 * instead of the app window — a session-losing detour on iOS.
 *
 * Icons are the existing brand PNGs, declared `any` only. They are NOT declared
 * maskable: these are unpadded marks, and claiming maskable on an unpadded icon
 * tells Android it may crop ~20% off every edge, which eats the wordmark. A
 * dedicated padded maskable icon is the right follow-up.
 *
 * The middleware matcher skips this path (see middleware.ts), so reading the
 * Host header here costs nothing beyond the render.
 */
export const dynamic = "force-dynamic";

export function GET() {
  const onAppHost = isAppHost(headers().get("host"));
  const startUrl = onAppHost ? "/" : "/app";

  return Response.json(
    {
      // `id` pins the app's identity across manifest edits. Without it the
      // identity is derived from start_url, so changing start_url later would
      // read as a different app and install a second icon beside the first.
      id: startUrl,
      name: "batch0",
      short_name: "batch0",
      description:
        "Your batch0 cohort on your phone — what's due, what's next, and who needs an answer.",
      start_url: startUrl,
      scope: "/",
      display: "standalone",
      orientation: "portrait",
      // Matches the dark `--background` token in globals.css, so the launch
      // splash and the app's own first paint are the same colour.
      background_color: "#0c0c0d",
      theme_color: "#0c0c0d",
      categories: ["education", "productivity"],
      icons: [
        { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
        { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      ],
      // Long-press the icon to jump straight in. Both hosts serve these paths,
      // so unlike start_url they need no per-host branch.
      shortcuts: [
        {
          name: "Weekly check-in",
          short_name: "Check in",
          url: "/app/checkin",
        },
        {
          name: "Review applications",
          short_name: "Review",
          url: "/app/admin/review",
        },
      ],
    },
    {
      headers: {
        "Content-Type": "application/manifest+json",
        // Short cache: the manifest is fetched on install and on launch, and a
        // day-long cache would strand an installed app on an old start_url.
        "Cache-Control": "public, max-age=3600",
      },
    },
  );
}
