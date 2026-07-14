import { ImageResponse } from "next/og";
import { getSiteConfig } from "@/lib/site-config";
import { ogFonts, OG_DISPLAY, OG_BODY } from "@/lib/og-fonts";

// Route segment config for the OG image. Next.js picks these up to build
// the actual /opengraph-image route + metadata. Runs on Node so we can
// share the Supabase admin client with the rest of the server. Marked
// dynamic so the active cohort is resolved at request time.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const alt =
  "batch0 — startup accelerator for high schoolers. Cohort facts: dates, tuition, no equity taken.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// DESIGN.md on a card: white paper, ink type, one yellow. The ledger rows
// carry the real cohort facts, same as the site's signature element.
export default async function OpengraphImage() {
  const [{ derived }, fonts] = await Promise.all([getSiteConfig(), ogFonts()]);
  const dates = derived.dateRangeLabel.replace("→", "–");
  const rows: [string, string][] = [
    ["COHORT", `${derived.cohortLabel || "Cohort"} · ${derived.cohortName}`],
    ["DATES", dates || "TBA"],
    ["TUITION", `${derived.priceLabel} · only if accepted`],
    ["EQUITY TAKEN", "none"],
  ];
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
          backgroundColor: "#ffffff",
          color: "#141414",
          fontFamily: OG_BODY,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            justifyContent: "space-between",
          }}
        >
          <div style={{ display: "flex", alignItems: "baseline", gap: 16 }}>
            <div style={{ display: "flex", fontFamily: OG_DISPLAY, fontSize: 44 }}>
              batch0
            </div>
            {/* Carries the rename into every shared link — the preview is
                often the only thing someone sees before deciding to click. */}
            <div style={{ display: "flex", fontSize: 17, color: "#767676" }}>
              formerly Sparkline Youth
            </div>
          </div>
          <div
            style={{
              display: "flex",
              fontSize: 20,
              color: "#767676",
            }}
          >
            batch0.org
          </div>
        </div>

        {/* VT323 has one weight and a fixed pixel grid: hierarchy comes from
            size, and tracking stays neutral — the negative tracking this
            headline used to carry collides the stems. */}
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div
            style={{
              display: "flex",
              fontFamily: OG_DISPLAY,
              fontSize: 92,
              lineHeight: 1.05,
            }}
          >
            Don&apos;t wait for college
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              fontFamily: OG_DISPLAY,
              fontSize: 92,
              lineHeight: 1.05,
            }}
          >
            to start
            <span
              style={{
                backgroundColor: "#FFBB00",
                padding: "0 14px",
                marginLeft: 18,
                display: "flex",
              }}
            >
              your company.
            </span>
          </div>
        </div>

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 10,
            borderTop: "2px solid #141414",
            paddingTop: 28,
          }}
        >
          {rows.map(([k, v]) => (
            <div
              key={k}
              style={{
                display: "flex",
                justifyContent: "space-between",
                fontSize: 22,
                fontFamily: OG_BODY,
              }}
            >
              <span style={{ display: "flex", color: "#767676" }}>{k}</span>
              <span style={{ display: "flex", fontWeight: 600 }}>{v}</span>
            </div>
          ))}
        </div>
      </div>
    ),
    { ...size, fonts },
  );
}
