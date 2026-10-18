import test from "node:test";
import assert from "node:assert/strict";
import * as nodeModule from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";

// Run with `npm test`. The real verifyChatUploads (lib/chat-files.ts) against
// an in-memory chat-files bucket. sendMessage hands every answer it gives back
// as a refusal, and refusals aren't logged (lib/action-result.ts), so the one
// answer that isn't the sender's doing — storage couldn't be read — has to be
// logged here or a storage outage is invisible.

const state = {
  objects: new Map<string, { size: number; mimetype: string }>(),
  listFails: false,
  logged: [] as unknown[][],
};
console.error = (...args: unknown[]) => void state.logged.push(args);

const bucket = {
  async list(folder: string, opts: { search?: string }) {
    if (state.listFails) return { data: null, error: { message: "Gateway Timeout" } };
    const data = [...state.objects.entries()]
      .filter(([p]) => p.startsWith(`${folder}/`) && p.slice(folder.length + 1).includes(opts.search ?? ""))
      .map(([p, meta]) => ({ name: p.slice(folder.length + 1), metadata: meta }));
    return { data, error: null };
  },
  async remove(paths: string[]) {
    for (const p of paths) state.objects.delete(p);
    return { data: null, error: null };
  },
};
(globalThis as any).__chatFilesVerify = { bucket };
const root = fileURLToPath(new URL("../", import.meta.url));
const fake = (source: string) => `data:text/javascript,${encodeURIComponent(source)}`;
(nodeModule as any).registerHooks({
  resolve(specifier: string, context: any, next: any) {
    const doubles: Record<string, string> = {
      "server-only": "export {};",
      "@/lib/supabase/admin":
        "const t=globalThis.__chatFilesVerify;export const createAdminClient=()=>({storage:{from:()=>t.bucket}});",
    };
    if (doubles[specifier]) return { url: fake(doubles[specifier]), shortCircuit: true };
    if (specifier.startsWith("@/")) {
      return next(pathToFileURL(path.join(root, specifier.slice(2) + ".ts")).href, context);
    }
    return next(specifier, context);
  },
});
const { verifyChatUploads } = await import("./chat-files.ts");
const { chatUploadPath } = await import("./chat-files-rules.ts");

const CHANNEL = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const filePath = chatUploadPath(CHANNEL, USER, "33333333-3333-4333-8333-333333333333", "notes.pdf");
const staged = [{ path: filePath, name: "notes.pdf" }];

function reset() {
  state.objects = new Map([[filePath, { size: 2048, mimetype: "application/pdf" }]]);
  state.listFails = false;
  state.logged = [];
}

test("a stored file is verified from what storage recorded, with nothing logged", async () => {
  reset();
  const r = await verifyChatUploads(staged, CHANNEL, USER);
  assert.deepEqual(r, {
    ok: true,
    attachments: [{ path: filePath, name: "notes.pdf", size: 2048, type: "application/pdf" }],
  });
  assert.deepEqual(state.logged, []);
});

test("storage failing is logged: the sender's answer alone would leave no trace", async () => {
  reset();
  state.listFails = true;
  const r = await verifyChatUploads(staged, CHANNEL, USER);
  assert.deepEqual(r, { ok: false, error: "Couldn't check your attachments. Try sending again." });
  assert.equal(state.logged.length, 1);
  assert.equal(state.logged[0][0], "[chat-files] attachment check failed");
  assert.equal(state.logged[0][1], "Gateway Timeout");
});

test("the sender's own problems are answered, not logged", async () => {
  reset();
  state.objects.clear();
  assert.deepEqual(await verifyChatUploads(staged, CHANNEL, USER), {
    ok: false,
    error: "notes.pdf didn't finish uploading. Attach it again.",
  });
  assert.deepEqual(await verifyChatUploads("nope", CHANNEL, USER), {
    ok: false,
    error: "Those attachments didn't come through. Attach them again.",
  });
  assert.deepEqual(state.logged, []);
});
