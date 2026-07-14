import { ImageResponse } from "next/og";
import { getPostBySlug, getPostSlugs, formatPostDate } from "@/lib/blog";

// Per-post social card. DESIGN.md on a 1200×630 canvas: white paper, ink
// type, one yellow rule. Static (one PNG per slug, built alongside the page)
// and ≥1200px wide, which is also what the BlogPosting `image` field wants.
export const runtime = "nodejs";
export const alt = "Sparkline Youth Blog";
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
  const title = post?.meta.title ?? "Sparkline Youth Blog";
  const category = post?.meta.category ?? "Playbook";
  const meta = post
    ? `${category} · ${formatPostDate(post.meta.date)} · ${post.meta.readingTime} min read`
    : "Startup guides for high schoolers";

  // Scale the headline down as it gets longer so it never overflows.
  const len = title.length;
  const fontSize = len > 90 ? 44 : len > 60 ? 52 : len > 40 ? 62 : 72;

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
            Sparkline Youth
          </div>
          <div style={{ display: "flex", fontSize: 20, color: "#767676" }}>
            The Sparkline Blog
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column" }}>
          <div
            style={{
              display: "flex",
              width: 96,
              height: 8,
              backgroundColor: "#FACC15",
              marginBottom: 28,
            }}
          />
          <div
            style={{
              display: "flex",
              fontSize,
              fontWeight: 800,
              letterSpacing: "-0.025em",
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
            fontFamily: "monospace",
            color: "#767676",
          }}
        >
          <span style={{ display: "flex" }}>{meta}</span>
          <span style={{ display: "flex" }}>sparklineyouth.org</span>
        </div>
      </div>
    ),
    { ...size },
  );
}
