import { ImageResponse } from "next/og";
import { getSiteConfig } from "@/lib/site-config";

// Route segment config for the OG image. Next.js picks these up to build
// the actual /opengraph-image route + metadata. Runs on Node so we can
// share the Supabase admin client with the rest of the server. Marked
// dynamic so the active cohort is resolved at request time.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const alt =
  "SparkLine Youth — startup accelerator for high schoolers. Cohort facts: dates, tuition, no equity taken.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// DESIGN.md on a card: white paper, ink type, one yellow. The ledger rows
// carry the real cohort facts, same as the site's signature element.
export default async function OpengraphImage() {
  const { derived } = await getSiteConfig();
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
          fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <div style={{ display: "flex", fontSize: 28, fontWeight: 700 }}>
            SparkLine Youth
          </div>
          <div
            style={{
              display: "flex",
              fontSize: 20,
              color: "#767676",
            }}
          >
            sparklineyouth.org
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column" }}>
          <div
            style={{
              display: "flex",
              fontSize: 72,
              fontWeight: 800,
              letterSpacing: "-0.025em",
              lineHeight: 1.05,
            }}
          >
            Don&apos;t wait for college
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              fontSize: 72,
              fontWeight: 800,
              letterSpacing: "-0.025em",
              lineHeight: 1.05,
            }}
          >
            to start
            <span
              style={{
                backgroundColor: "#FACC15",
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
                fontFamily: "monospace",
              }}
            >
              <span style={{ display: "flex", color: "#767676" }}>{k}</span>
              <span style={{ display: "flex", fontWeight: 600 }}>{v}</span>
            </div>
          ))}
        </div>
      </div>
    ),
    { ...size },
  );
}
