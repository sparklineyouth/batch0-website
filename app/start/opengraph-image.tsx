import { ImageResponse } from "next/og";
import { ogFonts, OG_DISPLAY, OG_BODY } from "@/lib/og-fonts";

export const runtime = "nodejs";
export const alt = "batch0 free founder starter kit. Five exercises. One testable idea. No signup needed.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function StarterKitOpengraphImage() {
  return new ImageResponse(
    <div style={{ width: "100%", height: "100%", padding: "56px 68px", backgroundColor: "#ffffff", color: "#141414", fontFamily: OG_BODY, display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ display: "flex", fontFamily: OG_DISPLAY, fontSize: 50 }}>batch0</div>
        <div style={{ display: "flex", backgroundColor: "#ffe600", borderRadius: 8, padding: "12px 20px", fontSize: 21 }}>FREE · NO SIGNUP</div>
      </div>
      <div style={{ display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", fontFamily: OG_DISPLAY, fontSize: 94, lineHeight: 1 }}>Five exercises.</div>
        <div style={{ display: "flex", fontFamily: OG_DISPLAY, fontSize: 94, lineHeight: 1 }}>One testable idea.</div>
        <div style={{ display: "flex", marginTop: 22, fontSize: 27, color: "#525252" }}>The founder starter kit for high schoolers.</div>
      </div>
      <div style={{ display: "flex", borderTop: "1px solid #dadada", paddingTop: 23, justifyContent: "space-between", fontSize: 22 }}>
        <span>Problem → Evidence → MVP → Users → Pitch</span>
        <span>batch0.org/start</span>
      </div>
    </div>,
    { ...size, fonts: await ogFonts() },
  );
}
