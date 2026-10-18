import test from "node:test";
import assert from "node:assert/strict";
import * as nodeModule from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";

// app/chat/api/reads.ts — the reads behind Chat's GET routes — for the parts
// threads (0110) added to the feed's page: #help's newest page carries its
// open-question count, so the header's Unanswered badge catches up on the
// 30-second resync rather than only when the channel is opened again; an
// older page, a window around a message, another channel, or a count that
// couldn't be read carries none (the screen keeps what it shows).

type Row = Record<string, any>;
const state = {
  channels: {} as Record<string, Row>,
  /** openQuestionCount's answer: a number, or null when it couldn't count. */
  count: 0 as number | null,
  counted: [] as string[],
  listed: [] as Row[],
};

(globalThis as any).__chatReads = { state };

const root = fileURLToPath(new URL("../", import.meta.url));
const fake = (source: string) => `data:text/javascript,${encodeURIComponent(source)}`;
const CHAT = [
  "buildSidebar", "countAttention", "getChatViewer", "getMessageRow", "getMessages", "listChannelPeople", "listPins",
  "listThreadReplies",
];
(nodeModule as any).registerHooks({
  resolve(specifier: string, context: any, next: any) {
    const g = "const t=globalThis.__chatReads;";
    const doubles: Record<string, string> = {
      "server-only": "export {};",
      "@/lib/auth": "export const getViewer=async()=>null;",
      "@/lib/chat":
        g +
        CHAT.map((n) => `export const ${n}=async()=>{throw new Error('${n} not in this test')};`).join("") +
        "export const getPeople=async()=>new Map();" +
        "export const openChannelFor=async(id)=>t.state.channels[id]?{channel:t.state.channels[id],viewer:{},reported:false}:null;" +
        "export const listMessages=async(id,o)=>{t.state.listed.push({id,...o});return{messages:[],hasMoreBefore:false,hasMoreAfter:false};};",
      "@/lib/chat-payload": "export const peopleIn=()=>[];",
      "@/lib/chat-about": "export const withAbout=async(m)=>m;",
      "@/lib/chat-threads":
        "export const describeThread=async()=>{throw new Error('no')};export const getThreadRow=async()=>null;export const threadsReady=async()=>true;",
      "@/lib/chat-questions":
        g +
        "export const listOpenQuestions=async()=>({questions:[],total:0});" +
        "export const openQuestionCount=async(id)=>(t.state.counted.push(id),t.state.count);",
    };
    if (doubles[specifier]) return { url: fake(doubles[specifier]), shortCircuit: true };
    if (specifier.startsWith("@/")) return next(pathToFileURL(path.join(root, specifier.slice(2) + ".ts")).href, context);
    return next(specifier, context);
  },
});

const { readMessages } = await import("../app/chat/api/reads.ts");

const HELP = "c0000000-0000-4000-8000-000000000001";
const GENERAL = "c0000000-0000-4000-8000-000000000002";
const READER = { userId: "u1", caps: null as any };

function reset() {
  state.channels = {
    [HELP]: { id: HELP, kind: "channel", systemKey: "help" },
    [GENERAL]: { id: GENERAL, kind: "channel", systemKey: null },
  };
  state.count = 3;
  state.counted = [];
  state.listed = [];
}

test("#help's newest page says how many questions are open; nothing else does", async () => {
  reset();
  const page = await readMessages(READER, HELP);
  assert.equal(page?.unanswered, 3, "the header's Unanswered badge reads it on every resync");
  assert.deepEqual(state.counted, [HELP]);
  // Another channel has no questions to count.
  const general = await readMessages(READER, GENERAL);
  assert.ok(general && !("unanswered" in general));
  // Scrolling back or opening around a message isn't the resync: no count, no extra read.
  const older = await readMessages(READER, HELP, { before: "2026-10-17T10:00:00.000Z", beforeId: HELP });
  const around = await readMessages(READER, HELP, { around: HELP });
  assert.ok(older && !("unanswered" in older));
  assert.ok(around && !("unanswered" in around));
  assert.deepEqual(state.counted, [HELP]);
});

test("a count that couldn't be read is left out, so the badge keeps its number rather than dropping to zero", async () => {
  reset();
  state.count = null;
  const page = await readMessages(READER, HELP);
  assert.ok(page && !("unanswered" in page));
  state.count = 0;
  assert.equal((await readMessages(READER, HELP))?.unanswered, 0, "a real zero is said");
  // A channel the reader can't open answers nothing at all.
  assert.equal(await readMessages(READER, "c0000000-0000-4000-8000-000000000009"), null);
});
