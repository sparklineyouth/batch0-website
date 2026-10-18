/**
 * Whether this page is running as the installed home-screen app rather than
 * in a browser tab: `display-mode: standalone` on both platforms, plus
 * `navigator.standalone` for older iOS. The same test as
 * components/app/install-hint.tsx. Takes the window so `node --test` can pass
 * a stand-in (lib/display-mode.test.ts); false wherever there's no window.
 */
export function isInstalledApp(
  win: { matchMedia?: (query: string) => { matches: boolean }; navigator?: unknown } | undefined = typeof window ===
  "undefined"
    ? undefined
    : window,
): boolean {
  if (!win) return false;
  try {
    if (win.matchMedia?.("(display-mode: standalone)").matches) return true;
  } catch {
    // An old engine without media-query support for display-mode.
  }
  return (win.navigator as { standalone?: boolean } | undefined)?.standalone === true;
}

/**
 * Whether a click on a link that would open a new tab should stay in this
 * window instead. In the installed app it should: on iOS a new tab leaves the
 * app for Safari (or an in-app browser), which doesn't share the app's
 * cookies, so a link to a route that needs the session lands on the sign-in
 * page. A modified or non-primary click is the reader asking for something
 * else and is left alone.
 */
export function keepInAppWindow(
  click: { button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean },
  installed: boolean,
): boolean {
  if (!installed) return false;
  return click.button === 0 && !click.metaKey && !click.ctrlKey && !click.shiftKey && !click.altKey;
}
