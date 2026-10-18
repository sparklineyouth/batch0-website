import test from "node:test";
import assert from "node:assert/strict";
import * as nodeModule from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";

// Chat threads' "Ask the team" (0110) and "Ask about this", against doubles
// of what they read and write:
//
//   lib/chat-help.ts   one help request per thread, kept in Support — made,
//                      linked (with a team-only note), reopened, or made anew
//                      after a closed one; two people asking at once end on
//                      one ticket.
//   lib/chat-about.ts  a question's lesson or assignment shows only to a
//                      viewer whose own database client can read that item.

type Row = Record<string, any>;
const state = {
  /** The thread row: what lib/chat-threads.ts getThreadRow answers. */
  thread: null as Row | null,
  tickets: new Map<string, Row>(),
  notes: [] as [string, string][],
  discarded: [] as string[],
  /** reopenChatHelpTicket's calls: [ticket, the status it reopened from]. */
  reopened: [] as [string, string][],
  /** Something moves the ticket to this status just before our reopen lands (the team, the cron). */
  moveBeforeReopen: null as string | null,
  made: 0,
  /** Before the link lands, someone else's request takes the thread (the race). */
  raceWith: null as string | null,
  /** lib/chat-about.ts: what each viewer's RLS client can read, and the chat_threads rows. */
  readable: { lessons: [] as Row[], assignments: [] as Row[] },
  rlsFails: false,
  threadRows: [] as Row[],
};
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** chat_threads' conditional link, profiles' name and email; chat_threads' rows for withAbout. */
function from(table: string) {
  const eqs: [string, unknown][] = [];
  const nulls: string[] = [];
  let patch: Row | null = null;
  const run = async () => {
    if (table === "profiles") return { data: { full_name: "Ava Patel", email: "ava@example.com" }, error: null };
    if (table === "chat_threads" && patch) {
      if (state.raceWith) {
        // The other request linked its ticket first.
        state.thread = { ...state.thread, helpTicketId: state.raceWith };
        state.raceWith = null;
      }
      const cur = state.thread?.helpTicketId ?? null;
      const want = eqs.find(([k]) => k === "help_ticket_id")?.[1] ?? (nulls.includes("help_ticket_id") ? null : undefined);
      if (want !== undefined && want !== cur) return { data: [], error: null };
      state.thread = { ...state.thread, helpTicketId: patch.help_ticket_id };
      return { data: [{ root_id: "r" }], error: null };
    }
    if (table === "chat_threads") return { data: state.threadRows, error: null };
    throw new Error(`unexpected ${table}`);
  };
  const chain: any = {
    select: () => chain,
    update: (p: Row) => ((patch = p), chain),
    eq: (k: string, v: unknown) => (eqs.push([k, v]), chain),
    is: (k: string) => (nulls.push(k), chain),
    in: () => chain,
    limit: () => chain,
    maybeSingle: () => run(),
    then: (ok: any, ko: any) => run().then(ok, ko),
  };
  return chain;
}

/** A viewer's own (RLS) client: it reads only what the item's policy lets them. */
function rlsClient() {
  return {
    from(table: string) {
      const chain: any = {
        select: () => chain,
        in: async (_k: string, ids: string[]) => {
          if (state.rlsFails) return { data: null, error: { message: "JWT expired" } };
          const rows = table === "lessons" ? state.readable.lessons : state.readable.assignments;
          return { data: rows.filter((r) => ids.includes(r.id)), error: null };
        },
      };
      return chain;
    },
  };
}

(globalThis as any).__chatHelp = { state, db: { from }, rlsClient };

const root = fileURLToPath(new URL("../", import.meta.url));
const fake = (source: string) => `data:text/javascript,${encodeURIComponent(source)}`;
(nodeModule as any).registerHooks({
  resolve(specifier: string, context: any, next: any) {
    const g = "const t=globalThis.__chatHelp;";
    const doubles: Record<string, string> = {
      "server-only": "export {};",
      "@/lib/supabase/admin": g + "export const createAdminClient=()=>t.db;",
      "@/lib/supabase/server": g + "export const createClient=async()=>t.rlsClient();",
      "@/lib/support":
        g +
        `export const createChatHelpTicket=async(x)=>{const id='00000000-0000-4000-8000-0000000090'+String(++t.state.made).padStart(2,'0');
           t.state.tickets.set(id,{id,reference:'B0-NEW'+t.state.made,status:'open',userId:x.userId,assignedTo:null,input:x});return{id,reference:'B0-NEW'+t.state.made};};
         export const addChatHelpNote=async(id,text)=>{t.state.notes.push([id,text]);};
         export const reopenChatHelpTicket=async(id,from)=>{t.state.reopened.push([id,from]);const k=t.state.tickets.get(id);
           if(t.state.moveBeforeReopen){const to=t.state.moveBeforeReopen;t.state.moveBeforeReopen=null;if(k)k.status=to;return false;}
           if(k&&k.status===from&&(from==='resolved'||from==='waiting_on_requester')){k.status='open';return true;}return false;};
         export const discardChatHelpTicket=async(id)=>{t.state.discarded.push(id);t.state.tickets.delete(id);};`,
      "@/lib/chat-threads":
        g +
        `export const ensureThreadRow=async()=>{if(!t.state.thread)t.state.thread={helpTicketId:null};};
         export const getThreadRow=async()=>t.state.thread;
         export const getHelpTicket=async(id)=>id?(t.state.tickets.get(id)??null):null;`,
    };
    if (doubles[specifier]) return { url: fake(doubles[specifier]), shortCircuit: true };
    if (specifier.startsWith("@/")) return next(pathToFileURL(path.join(root, specifier.slice(2) + ".ts")).href, context);
    return next(specifier, context);
  },
});

const { requestThreadHelp } = await import("./chat-help.ts");
const { aboutFor, withAbout } = await import("./chat-about.ts");
const { resetThreadsState } = await import("./chat-thread-rows.ts");

const CHANNEL = { id: uuid(1), name: "help" } as any;
const ROOT = uuid(10);
const REPLY = uuid(11);
const ME = uuid(100);

function reset() {
  state.thread = null;
  state.tickets = new Map();
  state.notes = [];
  state.discarded = [];
  state.reopened = [];
  state.moveBeforeReopen = null;
  state.made = 0;
  state.raceWith = null;
  state.readable = { lessons: [], assignments: [] };
  state.rlsFails = false;
  state.threadRows = [];
  resetThreadsState();
}

const ask = (over: Row = {}) =>
  requestThreadHelp({ channel: CHANNEL, rootId: ROOT, messageId: ROOT, askerId: ME, askerIsTeam: false, note: "stuck on outreach", ...over } as any);

test("the first ask makes the thread's help request in Support and links it; nothing of the thread is copied", async () => {
  reset();
  const r = await ask();
  assert.deepEqual([r.outcome, r.reference, r.yours], ["created", "B0-NEW1", true]);
  assert.equal(state.thread!.helpTicketId, r.ticketId);
  const filed = state.tickets.get(r.ticketId)!.input;
  assert.deepEqual(filed.chatThread, { channelId: CHANNEL.id, rootId: ROOT });
  assert.equal(filed.note, "stuck on outreach");
  assert.equal(filed.email, "ava@example.com", "the requester, from their profile, server side only");
  assert.ok(!("body" in filed), "the ticket gets a note and a link, never the thread's words");
});

test("while the request is in the team's queue, asking again joins it: the same ticket, and a note only the team sees", async () => {
  reset();
  const first = await ask();
  const again = await ask({ askerId: uuid(101), messageId: REPLY, note: "me too" });
  assert.deepEqual([again.outcome, again.ticketId], ["linked", first.ticketId]);
  assert.equal(state.made, 1, "one ticket for the thread");
  assert.deepEqual(state.notes, [[first.ticketId, "Ava Patel asked the team again about a reply in the thread: me too"]]);
  assert.deepEqual(state.reopened, [], "it's already with the team: no status moves");
  // The one who filed it, asking again, is told it's theirs.
  const mine = await ask();
  assert.deepEqual([mine.outcome, mine.reference, mine.yours], ["linked", "B0-NEW1", true]);
});

test("a second person asking isn't handed someone else's Support reference; the team is", async () => {
  reset();
  await ask();
  const second = await ask({ askerId: uuid(101), note: "me too" });
  assert.deepEqual([second.outcome, second.reference, second.yours], ["linked", null, false]);
  const staff = await ask({ askerId: uuid(102), askerIsTeam: true, note: "" });
  assert.deepEqual([staff.outcome, staff.reference, staff.yours], ["linked", "B0-NEW1", false]);
});

test("the team replied and is waiting on the asker: asking again in the thread puts it back in the queue", async () => {
  reset();
  const first = await ask();
  // A staff reply in Support moves it to waiting_on_requester by default
  // (lib/support-access.ts statusAfterStaffReply): out of "Needs reply".
  state.tickets.get(first.ticketId)!.status = "waiting_on_requester";
  const again = await ask({ askerId: uuid(101), note: "still stuck" });
  assert.deepEqual([again.outcome, again.ticketId], ["reopened", first.ticketId]);
  assert.deepEqual(state.reopened, [[first.ticketId, "waiting_on_requester"]]);
  assert.equal(state.tickets.get(first.ticketId)!.status, "open", "back in Needs reply, where the team will see it");
  assert.equal(state.made, 1);
  assert.deepEqual(state.notes, [[first.ticketId, "Ava Patel asked the team again: still stuck"]]);
  // It moved between our read and our reopen (here: the team resolved it):
  // we look again and reopen it from where it is now, rather than give up.
  state.tickets.get(first.ticketId)!.status = "waiting_on_requester";
  state.moveBeforeReopen = "resolved";
  const raced = await ask();
  assert.equal(raced.outcome, "reopened");
  assert.deepEqual(state.reopened.slice(1), [[first.ticketId, "waiting_on_requester"], [first.ticketId, "resolved"]]);
  assert.equal(state.tickets.get(first.ticketId)!.status, "open");
  assert.equal(state.notes.length, 2, "one note per ask, however many tries it took");
});

test("a handled request is reopened rather than duplicated; a closed one is final, and a new one takes the thread", async () => {
  reset();
  const first = await ask();
  state.tickets.get(first.ticketId)!.status = "resolved";
  const reopened = await ask();
  assert.deepEqual([reopened.outcome, reopened.ticketId], ["reopened", first.ticketId]);
  assert.deepEqual(state.reopened, [[first.ticketId, "resolved"]]);
  assert.equal(state.tickets.get(first.ticketId)!.status, "open", "the same record, back in the queue");
  state.tickets.get(first.ticketId)!.status = "closed";
  const fresh = await ask();
  assert.equal(fresh.outcome, "created");
  assert.notEqual(fresh.ticketId, first.ticketId);
  assert.equal(state.thread!.helpTicketId, fresh.ticketId, "the thread points at its live request");
});

test("two people asking at the same moment end on one request: the loser's ticket is taken back down", async () => {
  reset();
  // Theirs is already in Support; it lands on the thread between our read and our link.
  const theirs = uuid(9999);
  state.tickets.set(theirs, { id: theirs, reference: "B0-THEIRS", status: "open", userId: uuid(102), assignedTo: null });
  state.raceWith = theirs;
  const r = await ask();
  assert.deepEqual([r.outcome, r.ticketId, r.reference], ["linked", theirs, null], "theirs: no reference for us");
  assert.equal(state.discarded.length, 1, "ours was discarded");
  assert.ok(!state.tickets.has(state.discarded[0]));
  assert.equal(state.thread!.helpTicketId, theirs);
  assert.deepEqual(state.notes.map((n) => n[0]), [theirs]);
});

test("Ask about this: a question's lesson shows to a viewer who can open it, and to nobody else — not even that there is one", async () => {
  reset();
  const LESSON = uuid(500);
  const q = { id: ROOT, channelId: CHANNEL.id, thread: { replyCount: 0, lastReplyAt: null, question: "open", answerId: null } } as any;
  const plain = { id: uuid(12), channelId: CHANNEL.id } as any;
  state.threadRows = [{ root_id: ROOT, channel_id: CHANNEL.id, reply_count: 0, question: "open", about_kind: "lesson", about_id: LESSON }];
  // A student in that lesson's cohort: their own client reads it.
  state.readable.lessons = [{ id: LESSON, title: "Week 2 · Customer interviews" }];
  const [mine, untouched] = await withAbout([q, plain]);
  assert.deepEqual(mine.thread.about, { kind: "lesson", id: LESSON, title: "Week 2 · Customer interviews", href: `/dashboard/course/${LESSON}` });
  assert.equal(untouched, plain, "a message without a thread is left alone");
  assert.ok(await aboutFor({ kind: "lesson", id: LESSON }));
  // Someone in #help from another cohort: the lesson's policy says no, so no chip at all.
  state.readable.lessons = [];
  const [theirs] = await withAbout([q]);
  assert.ok(!("about" in theirs.thread), "no title, no id, no sign of a link");
  assert.equal(await aboutFor({ kind: "lesson", id: LESSON }), null);
  // A read that fails shows no chip rather than a wrong one.
  state.readable.lessons = [{ id: LESSON, title: "x" }];
  state.rlsFails = true;
  assert.ok(!("about" in (await withAbout([q]))[0].thread));
});

test("Ask about this: a link on a message that isn't a question and has no replies (a staff post, a quote) still shows its chip", async () => {
  reset();
  const ASSIGNMENT = uuid(501);
  // lib/chat.ts gives such a message an empty summary; withAbout fills its chip in.
  const post = { id: ROOT, channelId: CHANNEL.id, thread: { replyCount: 0, lastReplyAt: null, question: null, answerId: null } } as any;
  state.threadRows = [{ root_id: ROOT, channel_id: CHANNEL.id, reply_count: 0, question: null, about_kind: "assignment", about_id: ASSIGNMENT }];
  state.readable.assignments = [{ id: ASSIGNMENT, title: "Customer discovery log" }];
  const [shown] = await withAbout([post]);
  assert.deepEqual(shown.thread.about, {
    kind: "assignment",
    id: ASSIGNMENT,
    title: "Customer discovery log",
    href: `/dashboard/assignments/${ASSIGNMENT}`,
  });
});
