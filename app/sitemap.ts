import type { MetadataRoute } from "next";

const BASE = "https://sparklineyouth.org";

// Static marketing routes. Auth/product routes (/dashboard, /apply, /admin,
// /mentor, /investor) are deliberately omitted — they're gated and shouldn't
// show up in search. Cohort pages are public-facing and could be enumerated
// from Supabase here once they're stable; for now keep the list deterministic.
export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  return [
    { url: `${BASE}/`, lastModified: now, changeFrequency: "weekly", priority: 1 },
    { url: `${BASE}/sponsors`, lastModified: now, changeFrequency: "monthly", priority: 0.7 },
    { url: `${BASE}/terms`, lastModified: now, changeFrequency: "yearly", priority: 0.3 },
    { url: `${BASE}/privacy`, lastModified: now, changeFrequency: "yearly", priority: 0.3 },
    { url: `${BASE}/refund-policy`, lastModified: now, changeFrequency: "yearly", priority: 0.3 },
  ];
}
