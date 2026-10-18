"use client";
import type { ReactNode } from "react";
import { isInstalledApp, keepInAppWindow } from "@/lib/display-mode";

/**
 * A lesson material: a new tab in a browser, this window in the installed
 * app.
 *
 * The link is the materials route, which needs the session cookie to check
 * the student may read the lesson before it signs the file. In a browser a new
 * tab shares the cookie. In the iOS home-screen app it doesn't: `_blank`
 * leaves the app window for Safari or an in-app browser, which has its own
 * cookies, so the student got the sign-in page instead of the worksheet (the
 * same session-losing detour app/manifest.webmanifest/route.ts describes).
 * There the click navigates this window; the route answers with a redirect to
 * the signed file, which needs no cookie wherever iOS chooses to show it.
 */
export function MaterialLink({
  href,
  className,
  children,
}: {
  href: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={className}
      onClick={(e) => {
        if (e.defaultPrevented || !keepInAppWindow(e, isInstalledApp())) return;
        e.preventDefault();
        window.location.assign(href);
      }}
    >
      {children}
    </a>
  );
}
