import test from "node:test";
import assert from "node:assert/strict";
import * as nodeModule from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";

// Run the real deleteUserAccount (app/admin/students/[id]/actions.ts) against
// doubles, to pin the order that keeps the privacy policy true: the account's
// chat content is purged (lib/chat-purge.ts) BEFORE the auth user is deleted,
// and a purge that fails stops the deletion, so a retry finds the account.

const TARGET = "00000000-0000-4000-8000-0000000000aa";
const state: { calls: string[]; purgeFails: boolean } = { calls: [], purgeFails: false };
const db = {
  from(table: string) {
    const chain: any = {
      select: () => chain,
      eq: () => chain,
      maybeSingle: async () => {
        assert.equal(table, "profiles");
        return { data: { id: TARGET, email: "ada@example.com", full_name: "Ada", role: "student" }, error: null };
      },
    };
    return chain;
  },
  auth: {
    admin: {
      async deleteUser(id: string) {
        state.calls.push(`deleteUser:${id}`);
        return { error: null };
      },
    },
  },
};
(globalThis as any).__accountDeletion = { state, db };

const root = fileURLToPath(new URL("../", import.meta.url));
const fake = (source: string) => `data:text/javascript,${encodeURIComponent(source)}`;
(nodeModule as any).registerHooks({
  resolve(specifier: string, context: any, next: any) {
    const g = "const t=globalThis.__accountDeletion;";
    const doubles: Record<string, string> = {
      "next/cache": "export const revalidatePath=()=>{};",
      "@/lib/supabase/admin": g + "export const createAdminClient=()=>t.db;",
      "@/lib/server-guards": "export const assertAdmin=async()=>({userId:'actor'});export const assertPermission=async()=>({userId:'actor'});",
      "@/lib/roles": "export const capabilitiesForRole=async()=>({superAdmin:false,permissions:[]});",
      "@/lib/audit": g + "export const logAudit=async(e)=>{t.state.calls.push('audit:'+e.action);};",
      "@/lib/notifications": "export const notify=async()=>{};",
      "@/lib/email/send": "export const sendEmail=async()=>{};",
      "@/lib/stripe": "export const stripe={};",
      "@/lib/stripe-fulfillment": "export const handleChargeRefunded=async()=>{};",
      "@/lib/chat-purge":
        g +
        "export const purgeChatContentFor=async(id)=>{t.state.calls.push('purge:'+id);if(t.state.purgeFails)throw Error('storage is down');};",
      "@/lib/env": "export const env={siteUrl:'https://batch0.test'};",
    };
    if (doubles[specifier]) return { url: fake(doubles[specifier]), shortCircuit: true };
    if (specifier.startsWith("@/")) return next(pathToFileURL(path.join(root, specifier.slice(2) + ".ts")).href, context);
    return next(specifier, context);
  },
});
const { deleteUserAccount } = await import("../app/admin/students/[id]/actions.ts");

test("deleting an account purges its chat content first", async () => {
  state.calls = [];
  state.purgeFails = false;
  await deleteUserAccount(TARGET, "duplicate");
  assert.deepEqual(state.calls, [`purge:${TARGET}`, `deleteUser:${TARGET}`, "audit:user.deleted"]);
});

test("a purge that fails stops the deletion, so the account is still there to retry", async () => {
  state.calls = [];
  state.purgeFails = true;
  await assert.rejects(deleteUserAccount(TARGET, "duplicate"), /storage is down/);
  assert.deepEqual(state.calls, [`purge:${TARGET}`]);
});
