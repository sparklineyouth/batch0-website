"use client";
import { useEffect } from "react";
import { isAppHost } from "@/lib/app-host";

/**
 * Registers public/sw.js — but only on the app subdomain.
 *
 * The host check is the whole point. A service worker's reach is its origin, so
 * one registered from batch0.org/app would sit in front of the marketing site,
 * the blog and the auth funnel forever after. Registering only on
 * app.batch0.org means batch0.org has no service worker at all and cannot be
 * affected by one — which is the guarantee that lets this ship without holding
 * the highest-traffic pages on the site hostage to a caching bug.
 *
 * It also means the Android install prompt only appears on the subdomain.
 * That is intended: the subdomain is where installing gives you the right
 * start_url (see app/manifest.webmanifest/route.ts).
 *
 * Production only. In `next dev` the worker would sit in front of the dev
 * server's HMR navigations for the rest of the session, and an unregister is
 * not something you remember to do — you just lose an afternoon to a page that
 * won't update.
 *
 * The registration is fire-and-forget: everything works without a service
 * worker, so a failure is not worth surfacing to the user. It is logged,
 * because the one thing you want to know when "Install app" doesn't appear on
 * Android is whether the worker registered.
 */
export function RegisterSW() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!isAppHost(window.location.host)) return;
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker
      .register("/sw.js", { scope: "/" })
      .catch((err) =>
        console.error("[pwa] service worker registration failed", err),
      );
  }, []);
  return null;
}
