import { requireMentor, getCapabilities } from "@/lib/auth";
import { MentorSidebar } from "@/components/mentor/sidebar";
import { MobileNav } from "@/components/mobile-nav";
import { ChatDock } from "@/components/messages/chat-dock";

export default async function MentorLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const profile = await requireMentor();
  // Request-cached alongside the guard above, so this is not a second read.
  const caps = await getCapabilities();
  // Theme driven site-wide by next-themes on <html> (see ThemeProvider).
  return (
    <div
      className="flex min-h-screen bg-paper text-ink md:flex-row flex-col"
    >
      <MentorSidebar role={profile.role} caps={caps} />
      <div className="flex min-w-0 flex-1 flex-col">
        <MobileNav kind="mentor" role={profile.role} caps={caps} />
        {/* Skip-link target. tabIndex={-1} makes the non-focusable <main>
            focusable so screen readers actually move the cursor here. */}
        <main
          id="main-content"
          tabIndex={-1}
          className="flex-1 px-5 pb-24 pt-6 md:px-10 md:pb-24 md:pt-10"
        >
          {children}
        </main>
      </div>
      <ChatDock />
    </div>
  );
}
