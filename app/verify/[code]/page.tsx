import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card } from "@/components/ui/card";
import { LocalTime } from "@/components/ui/local-time";
import { ShieldCheck } from "lucide-react";
import Link from "next/link";

export async function generateMetadata({
  params,
}: {
  params: { code: string };
}) {
  const admin = createAdminClient();
  const { data: cert } = await admin
    .from("certificates")
    .select(
      "issued_at, user:profiles(full_name), cohort:cohorts(name)",
    )
    .eq("code", params.code)
    .maybeSingle();
  if (!cert) return { title: "Certificate · batch0" };
  const user = Array.isArray(cert.user) ? cert.user[0] : cert.user;
  return {
    title: `${user?.full_name ?? "Graduate"} · batch0 certificate`,
    openGraph: {
      images: [`/verify/${params.code}/og`],
    },
  };
}

export default async function VerifyCertificatePage({
  params,
}: {
  params: { code: string };
}) {
  const admin = createAdminClient();
  const { data: cert } = await admin
    .from("certificates")
    .select(
      "code, issued_at, user:profiles(full_name), cohort:cohorts(name, ends_on)",
    )
    .eq("code", params.code)
    .maybeSingle();
  if (!cert) notFound();
  const user = Array.isArray(cert.user) ? cert.user[0] : cert.user;
  const cohort = Array.isArray(cert.cohort) ? cert.cohort[0] : cert.cohort;

  return (
    <div className="min-h-screen bg-black text-white">
      <main className="mx-auto max-w-2xl px-5 py-16 md:px-8">
        <Link
          href="/"
          className="text-xs uppercase tracking-wider text-white/40 hover:text-white"
        >
          batch0
        </Link>
        <div className="mt-8 flex items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-emerald-400/15 text-emerald-300">
            <ShieldCheck className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">
              Verified certificate
            </h1>
            <p className="text-sm text-white/55">
              This certificate is genuine and issued by batch0.
            </p>
          </div>
        </div>
        <Card className="mt-8">
          <p className="text-xs uppercase tracking-wider text-white/40">
            Awarded to
          </p>
          <p className="mt-1 text-2xl font-semibold">
            {user?.full_name ?? "—"}
          </p>
          <p className="mt-5 text-xs uppercase tracking-wider text-white/40">
            For completing
          </p>
          <p className="mt-1 text-lg">{cohort?.name ?? "the program"}</p>
          {cohort?.ends_on && (
            <p className="text-xs text-white/50">
              Cohort ended {new Date(cohort.ends_on).toLocaleDateString()}
            </p>
          )}
          <p className="mt-6 text-xs uppercase tracking-wider text-white/40">
            Issued
          </p>
          <p className="mt-1 text-sm text-white/80">
            <LocalTime value={cert.issued_at} mode="date" />
          </p>
          <p className="mt-1 text-[11px] font-mono text-white/40">
            Code: {cert.code}
          </p>
        </Card>
        <p className="mt-6 text-center text-xs text-white/40">
          Verify any batch0 certificate at batch0.app/verify/&lt;code&gt;
        </p>
      </main>
    </div>
  );
}
