import type { MetadataRoute } from "next";

// Canonical host is www — the apex 307s there, so the sitemap must not
// hand crawlers redirecting URLs.
const BASE = "https://www.sparklineyouth.org";

// Static marketing routes. Auth/product routes (/dashboard, /apply, /admin,
// /mentor, /investor) are deliberately omitted — they're gated and shouldn't
// show up in search.
export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  return [
    { url: `${BASE}/`, lastModified: now, changeFrequency: "weekly", priority: 1 },
    { url: `${BASE}/program`, lastModified: now, changeFrequency: "monthly", priority: 0.9 },
    { url: `${BASE}/sponsors`, lastModified: now, changeFrequency: "monthly", priority: 0.7 },
    { url: `${BASE}/terms`, lastModified: now, changeFrequency: "yearly", priority: 0.3 },
    { url: `${BASE}/privacy`, lastModified: now, changeFrequency: "yearly", priority: 0.3 },
    { url: `${BASE}/refund-policy`, lastModified: now, changeFrequency: "yearly", priority: 0.3 },
  ];
}
