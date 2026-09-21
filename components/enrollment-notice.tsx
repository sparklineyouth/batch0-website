import type { SiteConfig } from "@/lib/site-config";

export function EnrollmentNotice({ config }: { config: SiteConfig }) {
  if (config.derived.applicationsAvailable && config.derived.enrollmentMode !== "late_entry") return null;
  return (
    <div className="mt-6 border-l-2 border-phosphor bg-wash px-4 py-3 text-sm leading-relaxed">
      <p className="font-semibold text-ink">{config.derived.applicationsCountdownLabel}</p>
      <p className="mt-2 text-ink-soft">{config.derived.enrollmentNote}</p>
    </div>
  );
}
