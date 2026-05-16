import { ImageResponse } from "next/og";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

/**
 * Renders a shareable certificate card as an OG image. Used by share
 * tooling (LinkedIn, etc.) when the verify URL is unfurled — and serves
 * as the canonical PNG of the certificate.
 */
export async function GET(
  _req: Request,
  { params }: { params: { code: string } },
) {
  const admin = createAdminClient();
  const { data: cert } = await admin
    .from("certificates")
    .select(
      "code, issued_at, user:profiles(full_name), cohort:cohorts(name)",
    )
    .eq("code", params.code)
    .maybeSingle();

  const name =
    (Array.isArray(cert?.user) ? (cert!.user as any)[0]?.full_name : (cert?.user as any)?.full_name) ??
    "Graduate";
  const cohort =
    (Array.isArray(cert?.cohort)
      ? (cert!.cohort as any)[0]?.name
      : (cert?.cohort as any)?.name) ?? "the program";
  const issued = cert?.issued_at
    ? new Date(cert.issued_at).toLocaleDateString()
    : "—";

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          alignItems: "center",
          background: "#0a0a0a",
          color: "white",
          fontFamily: "system-ui",
          padding: 64,
          position: "relative",
        }}
      >
        <div
          style={{
            position: "absolute",
            inset: 32,
            border: "1px solid rgba(255,255,255,0.15)",
            borderRadius: 24,
          }}
        />
        <div style={{ fontSize: 18, letterSpacing: 6, color: "#facc15", textTransform: "uppercase", fontWeight: 600 }}>
          SparkLine Youth
        </div>
        <div style={{ marginTop: 28, fontSize: 28, color: "rgba(255,255,255,0.55)" }}>
          Certificate of completion
        </div>
        <div style={{ marginTop: 40, fontSize: 64, fontWeight: 700, letterSpacing: -1 }}>
          {name}
        </div>
        <div style={{ marginTop: 24, fontSize: 26, color: "rgba(255,255,255,0.7)" }}>
          completed
        </div>
        <div style={{ marginTop: 12, fontSize: 36, color: "#facc15", fontWeight: 600 }}>
          {cohort}
        </div>
        <div style={{ marginTop: 56, fontSize: 20, color: "rgba(255,255,255,0.5)" }}>
          Issued {issued} · {cert?.code ?? "—"}
        </div>
      </div>
    ),
    {
      width: 1200,
      height: 630,
    },
  );
}
