import { ImageResponse } from "next/og";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSiteConfig } from "@/lib/site-config";
import { ogFonts, OG_DISPLAY, OG_BODY } from "@/lib/og-fonts";

// The unfurl IS the share — most people who see a pass link only ever see
// this image, so it redraws the ticket itself: the amber-phosphor CRT from
// FounderPassTicket, with the same ledger rows (code, cohort, claimed).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const alt = "A batch0 founder pass — amber phosphor terminal card.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const PHOSPHOR = "#FFBB00";

export default async function PassOpengraphImage({
  params,
}: {
  params: { serial: string };
}) {
  const admin = createAdminClient();
  const serial = /^\d{1,6}$/.test(params.serial)
    ? Number.parseInt(params.serial, 10)
    : -1;

  // select("*") tolerates a database where migration 0040 hasn't run.
  const [{ data }, { derived }, fonts] = await Promise.all([
    admin
      .from("founder_passes")
      .select("*")
      .eq("serial", serial)
      .not("redeemed_by", "is", null)
      .is("revoked_at", null)
      .maybeSingle(),
    getSiteConfig(),
    ogFonts(),
  ]);
  const row = data as {
    redeemed_by?: string;
    redeemed_code?: string | null;
    redeemed_at?: string | null;
  } | null;

  let name = "A batch0 founder";
  if (row?.redeemed_by) {
    const { data: profile } = await admin
      .from("profiles")
      .select("full_name")
      .eq("id", row.redeemed_by)
      .maybeSingle();
    name = (profile as { full_name: string | null } | null)?.full_name ?? name;
  }
  const serialLabel = `#${String(row ? serial : 0).padStart(3, "0")}`;
  const codeValue = row?.redeemed_code
    ? row.redeemed_code.toUpperCase()
    : `PASS ${serialLabel}`;
  const claimed = row?.redeemed_at
    ? new Date(row.redeemed_at)
        .toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
          timeZone: "UTC",
        })
        .toUpperCase()
    : null;

  const ledger = (label: string, value: string, spaced = false) => (
    <div
      style={{
        display: "flex",
        alignItems: "baseline",
        gap: 18,
        fontSize: 24,
        fontWeight: 600,
        letterSpacing: 4,
      }}
    >
      <div style={{ display: "flex", color: "rgba(255,187,0,0.5)" }}>
        {label}
      </div>
      <div
        style={{
          display: "flex",
          flexGrow: 1,
          // Satori only knows solid|dashed; dashed reads as the ledger's
          // dotted leader at this scale.
          borderBottom: "4px dashed rgba(255,187,0,0.3)",
          marginBottom: 6,
        }}
      />
      <div
        style={{
          display: "flex",
          color: "rgba(255,187,0,0.9)",
          letterSpacing: spaced ? 8 : 4,
        }}
      >
        {value}
      </div>
    </div>
  );

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "64px 72px",
          backgroundColor: "#0d0d0b",
          backgroundImage:
            "radial-gradient(closest-side at 50% 42%, rgba(255,187,0,0.14), rgba(255,187,0,0) 100%)",
          color: PHOSPHOR,
          fontFamily: OG_BODY,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
          }}
        >
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div
              style={{
                display: "flex",
                fontFamily: OG_DISPLAY,
                fontSize: 56,
                textShadow: "0 0 14px rgba(255,187,0,0.4)",
              }}
            >
              batch0
            </div>
            <div
              style={{
                display: "flex",
                marginTop: 6,
                fontSize: 20,
                fontWeight: 600,
                letterSpacing: 10,
                color: "rgba(255,187,0,0.6)",
              }}
            >
              FOUNDER PASS
            </div>
          </div>
          <div
            style={{
              display: "flex",
              fontSize: 34,
              fontWeight: 600,
              textShadow: "0 0 10px rgba(255,187,0,0.35)",
            }}
          >
            {serialLabel}
          </div>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            fontFamily: OG_DISPLAY,
            fontSize: name.length > 18 ? 78 : 108,
            lineHeight: 1,
            textShadow: "0 0 24px rgba(255,187,0,0.55)",
          }}
        >
          {name.toUpperCase()}
          <div
            style={{
              display: "flex",
              width: 34,
              height: 72,
              marginLeft: 20,
              backgroundColor: PHOSPHOR,
              boxShadow: "0 0 18px rgba(255,187,0,0.6)",
            }}
          />
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {ledger("CODE", codeValue, true)}
          {ledger("COHORT", derived.cohortHeadline.toUpperCase())}
          {claimed ? ledger("CLAIMED", claimed) : null}
        </div>
      </div>
    ),
    { ...size, fonts },
  );
}
