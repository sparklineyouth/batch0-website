import { ImageResponse } from "next/og";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSiteConfig } from "@/lib/site-config";
import { ogFonts, OG_DISPLAY, OG_BODY } from "@/lib/og-fonts";

// The unfurl IS the share — most people who see a pass link will only ever
// see this image, so it redraws the ticket itself (same layout as
// FounderPassTicket: eyebrow, name, meta, perforated FAST TRACK stub) rather
// than a generic card pointing at one.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const alt = "A numbered batch0 founder pass ticket.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const INK = "#141414";
const PAPER_DARK = "#0c0c0d";

export default async function PassOpengraphImage({
  params,
}: {
  params: { serial: string };
}) {
  const admin = createAdminClient();
  const serial = /^\d{1,6}$/.test(params.serial)
    ? Number.parseInt(params.serial, 10)
    : -1;

  const [{ data }, { derived }, fonts] = await Promise.all([
    admin
      .from("founder_passes")
      .select("serial, redeemed_by")
      .eq("serial", serial)
      .not("redeemed_by", "is", null)
      .is("revoked_at", null)
      .maybeSingle(),
    getSiteConfig(),
    ogFonts(),
  ]);

  let name = "A batch0 founder";
  if (data?.redeemed_by) {
    const { data: profile } = await admin
      .from("profiles")
      .select("full_name")
      .eq("id", (data as { redeemed_by: string }).redeemed_by)
      .maybeSingle();
    name = (profile as { full_name: string | null } | null)?.full_name ?? name;
  }
  const serialLabel = `#${String(data ? serial : 0).padStart(3, "0")}`;
  const notch = (style: Record<string, string | number>) => (
    <div
      style={{
        position: "absolute",
        width: 56,
        height: 56,
        borderRadius: 9999,
        backgroundColor: PAPER_DARK,
        display: "flex",
        ...style,
      }}
    />
  );

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: PAPER_DARK,
          fontFamily: OG_BODY,
        }}
      >
        <div
          style={{
            position: "relative",
            display: "flex",
            width: 1020,
            height: 520,
            borderRadius: 20,
            backgroundColor: "#FFBB00",
            backgroundImage:
              "radial-gradient(circle at 60% 25%, rgba(255,243,200,0.9), rgba(255,243,200,0) 55%)",
            color: INK,
            overflow: "hidden",
          }}
        >
          {/* Main body */}
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              justifyContent: "space-between",
              flex: 1,
              padding: "56px 64px",
            }}
          >
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                fontSize: 24,
                fontWeight: 600,
                letterSpacing: 8,
              }}
            >
              <div style={{ display: "flex" }}>BATCH0 PRESENTS</div>
              <div style={{ display: "flex", marginTop: 8 }}>FOUNDER PASS</div>
            </div>
            <div
              style={{
                display: "flex",
                fontFamily: OG_DISPLAY,
                fontSize: name.length > 18 ? 72 : 104,
                lineHeight: 1,
              }}
            >
              {name.toUpperCase()}
            </div>
            <div
              style={{
                display: "flex",
                fontSize: 24,
                fontWeight: 600,
                letterSpacing: 5,
                color: "rgba(20,20,20,0.8)",
              }}
            >
              {serialLabel} · {derived.cohortHeadline.toUpperCase()}
            </div>
          </div>

          {/* Stub. Satori's rotate() ignores transform-origin, so instead of
              the web ticket's rotated text the OG stub stacks glyphs in
              columns — same vertical read, no transforms to fight. */}
          <div
            style={{
              position: "relative",
              display: "flex",
              width: 260,
              alignItems: "center",
              justifyContent: "center",
              gap: 28,
              borderLeft: "3px dashed rgba(20,20,20,0.3)",
            }}
          >
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                fontSize: 24,
                fontWeight: 600,
                lineHeight: 1.35,
              }}
            >
              {"FAST".split("").map((ch, i) => (
                <div key={i} style={{ display: "flex" }}>
                  {ch}
                </div>
              ))}
            </div>
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                fontFamily: OG_DISPLAY,
                fontSize: 130,
                lineHeight: 0.92,
                color: "rgba(0,0,0,0.13)",
              }}
            >
              {serialLabel
                .replace("#", "")
                .split("")
                .map((ch, i) => (
                  <div key={i} style={{ display: "flex" }}>
                    {ch}
                  </div>
                ))}
            </div>
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                fontSize: 24,
                fontWeight: 600,
                lineHeight: 1.35,
              }}
            >
              {"TRACK".split("").map((ch, i) => (
                <div key={i} style={{ display: "flex" }}>
                  {ch}
                </div>
              ))}
            </div>
          </div>

          {/* Punched notches: corners + perforation ends */}
          {notch({ top: -28, left: -28 })}
          {notch({ top: -28, right: -28 })}
          {notch({ bottom: -28, left: -28 })}
          {notch({ bottom: -28, right: -28 })}
          {notch({ top: -28, right: 232 })}
          {notch({ bottom: -28, right: 232 })}
        </div>
      </div>
    ),
    { ...size, fonts },
  );
}
