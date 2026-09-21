"use client";
import { usePathname } from "next/navigation";
import { Analytics } from "@vercel/analytics/react";
import { SpeedInsights } from "@vercel/speed-insights/next";
import { GoogleAnalytics } from "@next/third-parties/google";
import { isPrivatePaymentPath } from "@/lib/payment-privacy";

export function SiteAnalytics({ googleEnabled, googleId }: { googleEnabled: boolean; googleId: string }) {
  const pathname = usePathname();
  if (isPrivatePaymentPath(pathname)) return null;
  const filter = <T extends { url: string }>(event: T): T | null => {
    const url = new URL(event.url, window.location.origin);
    if (isPrivatePaymentPath(window.location.pathname) || isPrivatePaymentPath(url.pathname)) return null;
    url.hash = "";
    return { ...event, url: url.toString() };
  };
  return <><Analytics beforeSend={filter} /><SpeedInsights beforeSend={filter} />{googleEnabled && <GoogleAnalytics gaId={googleId} />}</>;
}
