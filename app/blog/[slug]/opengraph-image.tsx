import { ImageResponse } from "next/og";
import { getPostBySlug, getPostSlugs, formatPostDate } from "@/lib/blog";
import { ogFonts, OG_DISPLAY, OG_BODY } from "@/lib/og-fonts";

// Per-post social card. DESIGN.md on a 1200×630 canvas: white paper, ink
// type, one yellow rule. Static (one PNG per slug, built alongside the page)
// and ≥1200px wide, which is also what the BlogPosting `image` field wants.
export const runtime = "nodejs";
export const alt = "batch0 Blog";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export async function generateStaticParams() {
  return (await getPostSlugs()).map((slug) => ({ slug }));
}

export default async function BlogPostOgImage({
  params,
}: {
  params: { slug: string };
}) {
  const post = await getPostBySlug(params.slug);
  const title = post?.meta.title ?? "batch0 Blog";
  const category = post?.meta.category ?? "Playbook";
  const meta = post
    ? `${category} · ${formatPostDate(post.meta.date)} · ${post.meta.readingTime} min read`
    : "Startup guides for high schoolers";

  // Scale the headline down as it gets longer so it never overflows. Sizes
  // run larger than the proportional face they replaced: VT323 is monospace
  // with a ~0.5em advance and a small optical size, so it both sets narrower
  // per character and reads smaller at the same px.
  const len = title.length;
  const fontSize = len > 90 ? 52 : len > 60 ? 62 : len > 40 ? 72 : 84;

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
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <div style={{ display: "flex", fontFamily: OG_DISPLAY, fontSize: 44 }}>
            batch0
          </div>
          <div style={{ display: "flex", fontSize: 20, color: "#767676" }}>
            The batch0 Blog
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column" }}>
          <div
            style={{
              display: "flex",
              width: 96,
              height: 8,
              backgroundColor: "#FFBB00",
              marginBottom: 28,
            }}
          />
          <div
            style={{
              display: "flex",
              fontFamily: OG_DISPLAY,
              fontSize,
              lineHeight: 1.05,
              maxWidth: 1000,
            }}
          >
            {title}
          </div>
        </div>

        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            borderTop: "2px solid #141414",
            paddingTop: 24,
            fontSize: 22,
            fontFamily: OG_BODY,
            color: "#767676",
          }}
        >
          <span style={{ display: "flex" }}>{meta}</span>
          <span style={{ display: "flex" }}>batch0.org</span>
        </div>
      </div>
    ),
    { ...size, fonts: await ogFonts() },
  );
}
