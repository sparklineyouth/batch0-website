import test from "node:test";
import assert from "node:assert/strict";
import { CAMPAIGN_MAX_AGE, campaignFromUrl, newCampaignCookie, persistCampaignAttribution, readCampaignCookie } from "./campaign-attribution.ts";

const now = new Date("2026-09-26T12:00:00Z");
const tagged = new URL("https://batch0.org/parents?utm_source=google&utm_medium=cpc&utm_campaign=batch0_search_2026&gclid=secret-click&email=student@example.com&utm_term=private-search#private");

test("Search capture retains only campaign labels, path and time", () => {
  assert.deepEqual(campaignFromUrl(tagged, now), {
    source: "google", medium: "cpc", campaign: "batch0_search_2026", landing_path: "/parents", first_touch_at: now.toISOString(),
  });
  assert.equal(campaignFromUrl(new URL("https://batch0.org/parents"), now), null);
  assert.equal(campaignFromUrl(new URL(tagged.toString().replace("google", "facebook")), now), null);
  assert.equal(campaignFromUrl(new URL(tagged.toString().replace("/parents?", "/pay?")), now), null);
  assert.equal(campaignFromUrl(new URL(tagged.toString().replace("batch0_search_2026", "student%40example.com")), now), null);
  for (const path of ["/parents", "/program", "/sample-lesson", "/apply"]) {
    const sitelink = new URL(tagged);
    sitelink.pathname = path;
    assert.equal(campaignFromUrl(sitelink, now)?.landing_path, path, `Search sitelink ${path} retains the campaign source`);
  }
});

test("signup and untagged navigation preserve first touch without extending expiry", () => {
  const cookie = newCampaignCookie(tagged, undefined, now)!;
  for (const path of ["/signup?next=%2Fapply", "/auth/callback", "/apply", "/parents?utm_source=google&utm_medium=cpc&utm_campaign=batch0_later"]) {
    assert.equal(newCampaignCookie(new URL(path, tagged), cookie, new Date(now.getTime() + 60_000)), null);
    assert.equal(readCampaignCookie(cookie, new Date(now.getTime() + 60_000))?.campaign, "batch0_search_2026");
  }
  const expired = new Date(now.getTime() + CAMPAIGN_MAX_AGE * 1000);
  assert.equal(readCampaignCookie(cookie, expired), null);
  assert.ok(newCampaignCookie(tagged, cookie, expired));
});

test("malformed, oversized, future and expired cookies are ignored; unknown fields are stripped", () => {
  for (const raw of ["%", "null", "{}", "[]", "x".repeat(801)]) assert.equal(readCampaignCookie(raw, now), null);
  const payload = campaignFromUrl(tagged, now)!;
  assert.equal(readCampaignCookie(encodeURIComponent(JSON.stringify({ ...payload, first_touch_at: "2027-01-01" })), now), null);
  assert.deepEqual(readCampaignCookie(encodeURIComponent(JSON.stringify({ ...payload, email: "secret@example.com", gclid: "secret" })), now), payload);
});

test("application persistence is insert-only and does not invent sources for untagged applicants", async () => {
  const writes: any[] = [];
  const db = { from(table: string) { assert.equal(table, "application_attributions"); return { async upsert(row: any, options: any) { writes.push({ row, options }); return { error: null }; } }; } };
  assert.equal(await persistCampaignAttribution(db, "application-1", undefined, now), true);
  assert.equal(writes.length, 0);
  assert.equal(await persistCampaignAttribution(db, "application-1", newCampaignCookie(tagged, undefined, now)!, now), true);
  assert.equal(writes[0].row.application_id, "application-1");
  assert.deepEqual(writes[0].options, { onConflict: "application_id", ignoreDuplicates: true });
  assert.equal(writes[0].row.gclid, undefined);
  const broken = { from() { return { async upsert() { return { error: new Error("database unavailable") }; } }; } };
  assert.equal(await persistCampaignAttribution(broken, "application-1", newCampaignCookie(tagged, undefined, now)!, now), false);
});
