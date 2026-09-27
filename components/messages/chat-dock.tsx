import { getViewer } from "@/lib/auth";
import { ChatWidget } from "@/components/messages/chat-widget";

/**
 * Mounts the chat dock for whoever is signed in. A server component so the
 * viewer id comes from the session rather than a prop any caller could get
 * wrong, and so a signed-out render costs nothing but a cached auth read.
 *
 * Mounted from every authed shell (dashboard, admin, mentor, investor) rather
 * than the root layout, because the marketing site has no business shipping a
 * chat launcher.
 */
export async function ChatDock() {
  // Request-cached: every one of those layouts already resolved the viewer, so
  // this is not a second round trip.
  const viewer = await getViewer();
  if (!viewer) return null;
  return <ChatWidget viewerId={viewer.profile.id} />;
}
