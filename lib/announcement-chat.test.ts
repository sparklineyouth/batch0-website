import test from "node:test";
import assert from "node:assert/strict";
import * as nodeModule from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";

// Run the real broadcastAnnouncement (app/admin/announcements/actions.ts)
// against doubles and look at what it hands postToChannel: the link a
// cut-short chat copy ends with, and the people who already got the
// announcement's own bell, so the chat copy rings none of them twice.

const ANN = "00000000-0000-4000-8000-0000000000a1";
const state: { posts: any[]; enrolled: string[]; insertFails: boolean } = { posts: [], enrolled: [], insertFails: false };
const db = {
  from(table: string) {
    const chain: any = {
      insert: () => chain,
      select: () => chain,
      eq: () => chain,
      single: async () => {
        assert.equal(table, "announcements");
        return state.insertFails ? { data: null, error: { message: "down" } } : { data: { id: ANN }, error: null };
      },
      then(resolve: any, reject: any) {
        assert.equal(table, "enrollments");
        return Promise.resolve({ data: state.enrolled.map((user_id) => ({ user_id, profile: null })), error: null }).then(resolve, reject);
      },
    };
    return chain;
  },
};
(globalThis as any).__announcementChat = { state, db };

const root = fileURLToPath(new URL("../", import.meta.url));
const fake = (source: string) => `data:text/javascript,${encodeURIComponent(source)}`;
(nodeModule as any).registerHooks({
  resolve(specifier: string, context: any, next: any) {
    const g = "const t=globalThis.__announcementChat;";
    const doubles: Record<string, string> = {
      "next/cache": "export const revalidateTag=()=>{};",
      "@/lib/app-cache": "export const cohortContentTag=(id)=>'app-content:'+id;export const GLOBAL_CONTENT_TAG='app-content:global';",
      "@/lib/supabase/admin": g + "export const createAdminClient=()=>t.db;",
      "@/lib/server-guards": "export const assertPermission=async()=>({userId:'author'});",
      "@/lib/audit": "export const logAudit=async()=>{};",
      "@/lib/email/send": "export const sendEmail=async()=>{};",
      "@/lib/notifications": "export const notifyMany=async()=>{};",
      "@/lib/chat-post": g + "export const postToChannel=async(target,input)=>{t.state.posts.push({target,input});return {ok:true,messageId:'m',channelId:'c'};};",
      "@/lib/env": "export const env={siteUrl:'https://batch0.test'};",
    };
    if (doubles[specifier]) return { url: fake(doubles[specifier]), shortCircuit: true };
    if (specifier.startsWith("@/")) return next(pathToFileURL(path.join(root, specifier.slice(2) + ".ts")).href, context);
    return next(specifier, context);
  },
});
const { broadcastAnnouncement } = await import("../app/admin/announcements/actions.ts");

const base = { cohortId: null, title: "Kickoff moved", body: "Now Tuesday.", sendEmail: false, postChat: true };

test("the chat copy links the announcement and bells nobody the announcement already belled", async () => {
  state.posts = [];
  state.insertFails = false;
  state.enrolled = ["s1", "s2", "s1"]; // enrolled in two cohorts: one bell, one exclusion
  await broadcastAnnouncement({ ...base, mentionEveryone: true });
  assert.equal(state.posts.length, 1);
  const { target, input } = state.posts[0];
  assert.deepEqual(target, { systemKey: "announcements" });
  assert.equal(input.mentionEveryone, true);
  assert.equal(input.link, `https://batch0.test/dashboard/announcements#a-${ANN}`);
  assert.deepEqual([...input.excludeBells].sort(), ["s1", "s2"]);
});

test("without @everyone, followers who got the announcement's bell still get no second one", async () => {
  state.posts = [];
  state.enrolled = ["s1"];
  await broadcastAnnouncement({ ...base, cohortId: "fall", mentionEveryone: false });
  const { target, input } = state.posts[0];
  assert.deepEqual(target, { systemKey: "cohort:fall" });
  assert.equal(input.mentionEveryone, false);
  assert.deepEqual(input.excludeBells, ["s1"]);
});

test("an announcement that wasn't saved has no page to link to", async () => {
  state.posts = [];
  state.insertFails = true;
  state.enrolled = [];
  await broadcastAnnouncement(base);
  assert.equal(state.posts[0].input.link, undefined);
});
