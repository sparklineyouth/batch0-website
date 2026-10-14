import { Alert, ActionLink } from "@/components/app/frame";
import { lockedCopy } from "@/components/dashboard/locked-feature";
import type { ApplicationStatus } from "@/lib/types";

/**
 * The installed app's locked screen body. The app admits submitted and
 * waitlisted applicants too (lib/app-eligibility.ts), so the copy follows the
 * application, as <LockedFeature> does: only an accepted one is told to pay.
 */
export function AppLockedAlert({
  title,
  applicationStatus,
}: {
  title: string;
  applicationStatus: ApplicationStatus | null;
}) {
  const { lede, cta } = lockedCopy(applicationStatus);
  return (
    <Alert
      tone="info"
      title={title}
      action={
        cta ? (
          <ActionLink href={cta.href} size="sm">
            {cta.label}
          </ActionLink>
        ) : undefined
      }
    >
      {lede}
    </Alert>
  );
}
