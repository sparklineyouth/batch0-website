/** First tagged Google Search visit, kept only on our site for 30 days. */
export const CAMPAIGN_COOKIE = "batch0_search_source";
export const CAMPAIGN_MAX_AGE = 30 * 24 * 60 * 60;

export type CampaignAttribution = {
  source: "google";
  medium: "cpc";
  campaign: string;
  landing_path: string;
  first_touch_at: string;
};

const campaignLabel = /^batch0_[a-z0-9_-]{1,80}$/;
const landingPaths = new Set(["/", "/parents", "/program", "/sample-lesson", "/apply", "/start"]);

/** Deliberately ignores click IDs, search terms, URLs, and personal details. */
export function campaignFromUrl(url: URL, now = new Date()): CampaignAttribution | null {
  const campaign = url.searchParams.get("utm_campaign") ?? "";
  if (url.searchParams.get("utm_source") !== "google" ||
      url.searchParams.get("utm_medium") !== "cpc" ||
      !campaignLabel.test(campaign) || !landingPaths.has(url.pathname)) return null;
  return { source: "google", medium: "cpc", campaign, landing_path: url.pathname, first_touch_at: now.toISOString() };
}

export function readCampaignCookie(raw: string | undefined, now = new Date()): CampaignAttribution | null {
  if (!raw || raw.length > 800) return null;
  try {
    const value = JSON.parse(decodeURIComponent(raw));
    const time = Date.parse(value.first_touch_at);
    if (value.source !== "google" || value.medium !== "cpc" ||
        typeof value.campaign !== "string" || !campaignLabel.test(value.campaign) ||
        !landingPaths.has(value.landing_path) || !Number.isFinite(time) ||
        time > now.getTime() || now.getTime() - time >= CAMPAIGN_MAX_AGE * 1000) return null;
    // Select fields rather than spreading untrusted cookie data.
    return { source: "google", medium: "cpc", campaign: value.campaign, landing_path: value.landing_path, first_touch_at: new Date(time).toISOString() };
  } catch { return null; }
}

/** Existing first touch wins; direct/organic visits never invent attribution. */
export function newCampaignCookie(url: URL, existing: string | undefined, now = new Date()): string | null {
  if (readCampaignCookie(existing, now)) return null;
  const campaign = campaignFromUrl(url, now);
  return campaign ? encodeURIComponent(JSON.stringify(campaign)) : null;
}

type AttributionWriter = {
  from(table: string): {
    upsert(row: Record<string, unknown>, options: { onConflict: string; ignoreDuplicates: boolean }): PromiseLike<{ error: unknown }>;
  };
};

/** The application ID, not the payer's browser, is the durable revenue join. */
export async function persistCampaignAttribution(db: AttributionWriter, applicationId: string, raw: string | undefined, now = new Date()): Promise<boolean> {
  const campaign = readCampaignCookie(raw, now);
  if (!campaign) return true;
  const { error } = await db.from("application_attributions").upsert(
    { application_id: applicationId, ...campaign },
    { onConflict: "application_id", ignoreDuplicates: true },
  );
  return !error;
}
