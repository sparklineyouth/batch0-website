import { ImageResponse } from "next/og";
import { getSiteConfig } from "@/lib/site-config";

// Route segment config for the OG image. Next.js picks these up to build
// the actual /opengraph-image route + metadata. Runs on Node so we can
// share the Supabase admin client with the rest of the server. Marked
// dynamic so the active cohort is resolved at request time — saving the
// admin settings invalidates this route via revalidatePath.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const alt = "SparkLine Youth — The 4-Week Entrepreneurship Program for High Schoolers";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function OpengraphImage() {
  const { derived } = await getSiteConfig();
  const headline = `${derived.cohortHeadline} · ${derived.priceLabel}`;
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "72px",
          backgroundColor: "#000000",
          backgroundImage:
            "radial-gradient(ellipse at top, rgba(250,204,21,0.22), rgba(0,0,0,1) 60%)",
          color: "#ffffff",
          fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <div
            style={{
              width: 56,
              height: 56,
              borderRadius: 14,
              background: "#FACC15",
              boxShadow: "0 0 80px rgba(250,204,21,0.55)",
            }}
          />
          <span
            style={{
              fontSize: 36,
              fontWeight: 700,
              letterSpacing: -1,
            }}
          >
            Spark<span style={{ color: "#FACC15" }}>Line</span> Youth
          </span>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          <div
            style={{
              display: "flex",
              alignSelf: "flex-start",
              padding: "8px 16px",
              borderRadius: 999,
              border: "1px solid rgba(250,204,21,0.35)",
              background: "rgba(250,204,21,0.1)",
              color: "#FACC15",
              fontSize: 22,
              fontWeight: 500,
            }}
          >
            {headline}
          </div>
          <div
            style={{
              fontSize: 84,
              lineHeight: 1.05,
              fontWeight: 800,
              letterSpacing: -2.5,
              maxWidth: 1000,
            }}
          >
            Learn to build a startup.
            <br />
            Pitch it to <span style={{ color: "#FACC15" }}>investors</span>.
          </div>
          <div
            style={{
              fontSize: 28,
              color: "rgba(255,255,255,0.6)",
              maxWidth: 900,
            }}
          >
            The 4-week, fully virtual entrepreneurship program for U.S. high schoolers.
          </div>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            fontSize: 22,
            color: "rgba(255,255,255,0.45)",
          }}
        >
          <span>sparklineyouth.org</span>
          <span>Ages 13–18 · Fully Virtual</span>
        </div>
      </div>
    ),
    { ...size },
  );
}
