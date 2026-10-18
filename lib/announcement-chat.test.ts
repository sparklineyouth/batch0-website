import test from "node:test";
import assert from "node:assert/strict";
import * as nodeModule from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";

// Run the real broadcastAnnouncement (app/admin/announcements/actions.ts)
// against doubles and look at what it hands postToChannel: the whole text
// (a long one is split into messages there, never cut with a link some
// readers can't open), and the people who already got the announcement's own
// bell, so the chat copy rings none of them twice.

const ANN = "00000000-0000-4000-8000-0000000000a1";
const state: { posts: any[]; enrolled: string[]; insertFails: boolean; postResult: any; deletes: string[] } = {
  posts: [],
  enrolled: [],
  insertFails: false,
  postResult: { ok: true, messageId: "m", messageIds: ["m"], channelId: "c" },
  deletes: [],
};
const db = {
  from(table: string) {
    let deleting = false;
    const chain: any = {
      insert: () => chain,
      select: () => chain,
      eq: () => chain,
      like: (k: string, pattern: string) => (state.deletes.push(`${table} where ${k} like ${pattern}`), chain),
      delete: () => ((deleting = true), state.deletes.push(table), chain),
      single: async () => {
        assert.equal(table, "announcements");
        return state.insertFails ? { data: null, error: { message: "down" } } : { data: { id: ANN }, error: null };
      },
      then(resolve: any, reject: any) {
        if (deleting) return Promise.resolve({ error: null }).then(resolve, reject);
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
      "@/lib/chat-post": g + "export const postToChannel=async(target,input)=>{t.state.posts.push({target,input});return t.state.postResult;};",
    };
    if (doubles[specifier]) return { url: fake(doubles[specifier]), shortCircuit: true };
    if (specifier.startsWith("@/")) return next(pathToFileURL(path.join(root, specifier.slice(2) + ".ts")).href, context);
    return next(specifier, context);
  },
});
const { broadcastAnnouncement, deleteAnnouncement } = await import("../app/admin/announcements/actions.ts");

const base = { cohortId: null, title: "Kickoff moved", body: "Now Tuesday.", sendEmail: false, postChat: true };

test("the chat copy is the whole announcement and bells nobody the announcement already belled", async () => {
  state.posts = [];
  state.insertFails = false;
  state.enrolled = ["s1", "s2", "s1"]; // enrolled in two cohorts: one bell, one exclusion
  const long = "Now Tuesday. ".repeat(600).trim(); // past one chat message
  await broadcastAnnouncement({ ...base, body: long, mentionEveryone: true });
  assert.equal(state.posts.length, 1);
  const { target, input } = state.posts[0];
  assert.deepEqual(target, { systemKey: "announcements" });
  assert.equal(input.mentionEveryone, true);
  assert.equal(input.body, `**Kickoff moved**\n\n${long}`, "not cut: postToChannel splits it");
  // No "read the rest" link: /dashboard/announcements is for enrolled
  // students, and mentors, investors and accepted applicants read the channel.
  assert.equal("link" in input, false);
  assert.ok(!JSON.stringify(input).includes("/dashboard/announcements"));
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

test("an announcement that wasn't saved still gets its chat copy", async () => {
  state.posts = [];
  state.insertFails = true;
  state.enrolled = [];
  const out = await broadcastAnnouncement(base);
  assert.equal(out.announcementId, null);
  assert.equal(state.posts.length, 1);
  assert.equal(out.chatPosted, true);
});

test("a muted author's announcement goes out, its chat copy doesn't, and the composer is told why", async () => {
  state.posts = [];
  state.insertFails = false;
  state.enrolled = ["s1"];
  state.postResult = { ok: false, reason: "You can't post in chat right now." };
  try {
    const out = await broadcastAnnouncement({ ...base, mentionEveryone: true });
    assert.equal(out.recipients, 1);
    assert.equal(out.announcementId, ANN);
    assert.equal(out.chatPosted, false);
    assert.equal(out.chatError, "You can't post in chat right now.");
  } finally {
    state.postResult = { ok: true, messageId: "m", messageIds: ["m"], channelId: "c" };
  }
});

test("deleting an announcement clears its own bells, and a malformed id clears nobody's", async () => {
  state.deletes = [];
  await deleteAnnouncement(ANN);
  assert.deepEqual(state.deletes, ["notifications", `notifications where link like %a-${ANN}%`, "announcements"]);
  // The id becomes a LIKE pattern: "%" used to match every announcement's
  // bells, deleted before the announcement delete failed on the bad id.
  state.deletes = [];
  for (const bad of ["%", "_", "", "not-a-uuid"]) {
    await assert.rejects(deleteAnnouncement(bad), /doesn't exist/, bad);
  }
  assert.deepEqual(state.deletes, []);
});
