import Link from "next/link";
import { requireUser, getProfile } from "@/lib/auth";
import { SettingsForm } from "./settings-form";
import { ThemeToggle } from "./theme-toggle";
import { Card } from "@/components/ui/card";
import type { Theme } from "@/lib/types";

export const metadata = { title: "Settings · batch0" };

export default async function SettingsPage() {
  const user = await requireUser();
  // Profile comes from the request-cached getProfile() the layout already
  // resolved — it carries every column this page reads.
  const profile = await getProfile();

  const theme: Theme = profile?.theme === "light" ? "light" : "dark";

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-3xl font-bold tracking-tight">Settings</h1>

      <Card className="mt-8">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-ink-soft">
          Appearance
        </h2>
        <ThemeToggle initial={theme} />
      </Card>

      <Card className="mt-6">
        <SettingsForm
          initialFullName={profile?.full_name ?? ""}
          email={user.email ?? ""}
        />
      </Card>

      {/* The things settings can't do, and who does them. There is no
          self-serve email change, account merge or account deletion — the
          team does each by hand — so someone who came here looking for one
          should leave with a door rather than a dead end. Deletion is named
          in the copy on purpose: it's what people scan a settings page for.
          Small type: these are help, not settings. */}
      <div className="mt-6 space-y-1.5 text-xs text-ink-faint">
        {/* The number and the texting opt-in live on their own page (it's the
            one a carrier reviews). Linked here because "stop texting me" and
            "change my number" are settings-page questions, and the privacy
            policy and /texts both point people at that page by name. */}
        <p>
          Your phone number, or texts on or off?{" "}
          <Link
            href="/dashboard/phone"
            prefetch={false}
            className="text-ink-soft underline decoration-line underline-offset-2 hover:text-ink hover:decoration-phosphor"
          >
            Phone &amp; texts
          </Link>
        </p>
        <p>
          Two accounts to merge?{" "}
          <Link
            href="/dashboard/support/new?topic=account&source=settings"
            prefetch={false}
            className="text-ink-soft underline decoration-line underline-offset-2 hover:text-ink hover:decoration-phosphor"
          >
            Account or sign-in problem
          </Link>
        </p>
        <p>
          A copy of your data, a correction, or your account deleted?{" "}
          <Link
            href="/dashboard/support/new?topic=privacy&source=settings"
            prefetch={false}
            className="text-ink-soft underline decoration-line underline-offset-2 hover:text-ink hover:decoration-phosphor"
          >
            Data &amp; privacy request
          </Link>
        </p>
      </div>
    </div>
  );
}
