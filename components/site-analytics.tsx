"use client";
import { usePathname } from "next/navigation";
import { Analytics } from "@vercel/analytics/react";
import { SpeedInsights } from "@vercel/speed-insights/next";
import { GoogleAnalytics } from "@next/third-parties/google";
import { isAnalyticsBlockedPath } from "@/lib/payment-privacy";

export function SiteAnalytics({ googleEnabled, googleId }: { googleEnabled: boolean; googleId: string }) {
  const pathname = usePathname();
  // Blocks payment surfaces AND pages whose URL is itself a bearer credential
  // (/support/t/<token>). On those, the pathname is the secret, so a pageview
  // would be the leak — see isSecretUrlPath in lib/payment-privacy.ts.
  if (isAnalyticsBlockedPath(pathname)) return null;
  const filter = <T extends { url: string }>(event: T): T | null => {
    const url = new URL(event.url, window.location.origin);
    if (isAnalyticsBlockedPath(window.location.pathname) || isAnalyticsBlockedPath(url.pathname)) return null;
    url.hash = "";
    return { ...event, url: url.toString() };
  };
  return <><Analytics beforeSend={filter} /><SpeedInsights beforeSend={filter} />{googleEnabled && <GoogleAnalytics gaId={googleId} />}</>;
}
