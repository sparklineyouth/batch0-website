import { requireMentor } from "@/lib/auth";
import { MentorSidebar } from "@/components/mentor/sidebar";
import { MobileNav } from "@/components/mobile-nav";

export default async function MentorLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const profile = await requireMentor();
  // Flat-black dark-only; surfaces use the reactive ink/paper tokens.
  return (
    <div
      className="flex min-h-screen bg-paper text-ink md:flex-row flex-col"
    >
      <MentorSidebar role={profile.role} />
      <div className="flex flex-1 flex-col">
        <MobileNav kind="mentor" role={profile.role} />
        <main className="flex-1 px-5 py-6 md:px-10 md:py-10">{children}</main>
      </div>
    </div>
  );
}
