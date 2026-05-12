import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        // Gated areas have no public value — block them from crawl budgets
        // even though middleware will also redirect bots.
        disallow: [
          "/dashboard",
          "/admin",
          "/mentor",
          "/investor",
          "/apply",
          "/auth",
          "/api",
        ],
      },
    ],
    sitemap: "https://sparklineyouth.org/sitemap.xml",
  };
}
